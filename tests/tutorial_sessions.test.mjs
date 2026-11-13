import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { startServer, root } from './helpers/server.mjs';
import { seedManualsOnce } from '../server/manual-seed.js';
import { TutorialStore } from '../server/tutorial-store.js';
import { createTutorial } from '../server/tutorial.js';
import { tutorialOwnerKey } from '../server/tutorial-identity.js';

const digest = b => crypto.createHash('sha256').update(b).digest('hex');

test('튜토리얼 메뉴: 설명서 5종과 보고서, 로그인/목록 조회에는 복사하지 않고 원본을 보존한다', async () => {
  const srv = await startServer({ config: { manuals: { seed: true } } });
  try {
    const A = srv.api('a'); const B = srv.api('b');
    const sources = fs.readdirSync(path.join(root, 'docs/manuals')).filter(n => n.endsWith('.hwpx'));
    const before = sources.map(n => digest(fs.readFileSync(path.join(root, 'docs/manuals', n))));
    assert.equal((await A('/api/me')).tutorial, true, '별도 체험 계정 설정이 없어도 메뉴 사용');
    const status = await A('/api/tutorial');
    // 2026-11-12: AI 작업 튜토리얼(ai-work 새 코스 포함)을 앞에, 한/글 편집 기능 소개는 뒤로
    assert.deepEqual(status.items.map(i => i.id), ['report', 'ai-work', 'ai-requests', 'ai-connect', 'ai-advanced', 'overview', 'clipboard', 'admin']);
    assert.deepEqual(status.items.map(i => i.number), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(status.items.map(i => i.guided), [true, true, true, true, true, true, true, false]);
    assert.equal(status.items[7].reference, true);
    assert.ok(!JSON.stringify(status.items).includes('따라하기'));
    assert.ok(status.items.every(i => !i.file));
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'docs')), []);
    for (const item of status.items) {
      const session = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: item.id } });
      const info = await A(`/api/docs/${session.docId}`);
      assert.equal(info.tutorialSession, true);
      assert.equal(info.tutorialGuided, item.id !== 'admin');
      assert.equal(info.settings.editMode, 'realtime');
      assert.equal(info.canConfigure, false);
      if (item.id === 'ai-connect') {
        const content=(await A(`/api/docs/${session.docId}/paragraphs`)).map(p=>p.text).join('\n');
        assert.ok(content.includes('사용자 가이드') && content.includes('API 키 생성'));
        const current=fs.readFileSync(path.join(srv.dataDir,'tutorial-sessions/docs',session.docId,'current.hwpx'));
        assert.equal(current.readUInt16LE(8),0,'연습 사본도 HWPX mimetype 무압축을 유지');
      }
      assert.equal((await B.res(`/api/docs/${session.docId}`)).status, 404);
      assert.equal((await srv.api('admin').res(`/api/docs/${session.docId}`)).status, 404, '임시 연습은 관리자도 타인 것을 열지 않는다');
      if (item.id === 'clipboard') {
        const paras = await A(`/api/docs/${session.docId}/paragraphs`);
        assert.ok(paras.some(p => p.text.includes('튜토리얼')));
        assert.ok(!paras.some(p => /따라\s*하기/.test(p.text)));
      }
      if (['overview', 'admin'].includes(item.id)) {
        const text = (await A(`/api/docs/${session.docId}/paragraphs`)).map(p => p.text).join('\n');
        assert.ok(!text.includes('서버를 처음 켤 때 자동으로'));
        assert.ok(!text.includes('.manuals-seeded.json'));
      }
      if (item.id === 'ai-advanced' || item.id === 'ai-work') {
        assert.equal(info.tutorialOwnAi, true, '같은 연습 보고서의 AI 튜토리얼은 예시 답변 경로');
        assert.deepEqual((await A(`/api/docs/${session.docId}/attachments`)).map(a => a.name), ['재수강 경험자 설문 결과(가상).xlsx', '보고서 작성 규칙(예시).skill']);
      }
      if (item.id === 'ai-requests') {
        const reqs = await A(`/api/docs/${session.docId}/requests`);
        assert.deepEqual(reqs.map(r => r.status), ['done', 'pending', 'failed', 'pending']);
        assert.equal((await A(`/api/docs/${session.docId}/proposals`)).length, 3);
        assert.ok((await A(`/api/docs/${session.docId}/memos`)).some(m => m.text.startsWith('수치의 근거')));
      }
    }
    assert.equal((await A('/api/tutorial')).sessions.length, 8);
    assert.deepEqual((await B('/api/tutorial')).sessions, []);
    assert.deepEqual((await A('/api/library')).docs, []);
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'docs')), []);
    assert.deepEqual(sources.map(n => digest(fs.readFileSync(path.join(root, 'docs/manuals', n)))), before);
    assert.equal(await seedManualsOnce({ cfg: { manuals: { seed: true } } }), null, '옛 자동 배포 설정으로도 문서를 미리 넣지 않는다');
  } finally { await srv.stop(); }
});

test('완료: 연습 내용·버전·메모 보존, 본인 문서함에 한 번만 저장, 재시작과 처음부터에도 완료본 보존', async () => {
  const srv = await startServer();
  try {
    let A = srv.api('a');
    const { docId } = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'clipboard' } });
    const temp = path.join(srv.dataDir, 'tutorial-sessions/docs', docId);
    const p = (await A(`/api/docs/${docId}/paragraphs`)).find(p => p.text && p.kind === 'text');
    await A(`/api/docs/${docId}/memos`, { method: 'POST', body: { ref: p.ref, text: '튜토리얼 연습 기록' } });
    const attachment = await A(`/api/docs/${docId}/attachments`, { method: 'POST', body: Buffer.from('연습 자료'), headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': 'practice.txt' } });
    assert.ok(fs.existsSync(path.join(temp, 'attachments', attachment.file)));
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'docs')), [], '첨부도 일반 문서 경로를 만들지 않는다');
    const bytes = fs.readFileSync(path.join(temp, 'current.hwpx'));
    const meta = JSON.parse(fs.readFileSync(path.join(temp, 'meta.json')));
    assert.equal((await A.res(`/api/docs/${docId}/location`, { method: 'PATCH', body: { space: 'public' } })).status, 403, '완료 전 이동으로 저장을 우회할 수 없다');
    assert.equal((await srv.api('b').res(`/api/tutorial/${docId}/complete`, { method: 'POST' })).status, 404);
    const results = await Promise.all([1, 2].map(() => A(`/api/tutorial/${docId}/complete`, { method: 'POST' })));
    assert.ok(results.every(r => r.saved && r.docId === docId));
    assert.ok(!fs.existsSync(temp));
    const permanent = path.join(srv.dataDir, 'docs', docId);
    assert.equal(digest(fs.readFileSync(path.join(permanent, 'current.hwpx'))), digest(bytes));
    const savedMeta = JSON.parse(fs.readFileSync(path.join(permanent, 'meta.json')));
    assert.deepEqual(savedMeta.versions, meta.versions);
    assert.deepEqual(savedMeta.memoThreads, meta.memoThreads);
    assert.equal(fs.readFileSync(path.join(permanent, 'attachments', attachment.file), 'utf8'), '연습 자료');
    assert.equal(savedMeta.tutorialSession, false);
    assert.equal(savedMeta.spaceOwner, srv.users.a.name);
    assert.equal((await A('/api/library')).docs.length, 1);
    assert.equal((await A(`/api/docs/${docId}/memos`)).some(m => m.text === '튜토리얼 연습 기록'), true);
    assert.equal((await A.res(`/api/tutorial/${docId}`, { method: 'DELETE' })).status, 409, '완료본을 임시문서 버리기로 지우지 않는다');
    const fresh = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'clipboard', reset: true } });
    assert.notEqual(fresh.docId, docId);
    assert.ok(!(await A(`/api/docs/${fresh.docId}/memos`)).some(m => m.text === '튜토리얼 연습 기록'));
    await srv.restart(); A = srv.api('a');
    assert.equal((await A('/api/tutorial')).sessions[0].docId, fresh.docId);
    assert.deepEqual((await A('/api/docs')).map(d => d.id), [docId]);
    await A(`/api/tutorial/${fresh.docId}`, { method: 'DELETE' });
    assert.deepEqual((await A('/api/tutorial')).sessions, []);
    assert.deepEqual((await A('/api/docs')).map(d => d.id), [docId]);
  } finally { await srv.stop(); }
});

test('잘못된 항목은 생성하지 않고 일반 문서를 완료 API로 저장할 수 없다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    assert.equal((await A.res('/api/tutorial/start', { method: 'POST', body: { tutorialId: '../../config' } })).status, 404);
    assert.equal((await A.res('/api/tutorial/nonexistent/complete', { method: 'POST' })).status, 404);
    assert.deepEqual((await A('/api/tutorial')).sessions, []);
    const normal = await A('/api/library/docs', { method: 'POST', body: { title: '일반 문서' } });
    assert.equal((await A.res(`/api/tutorial/${normal.id}/complete`, { method: 'POST' })).status, 404);
  } finally { await srv.stop(); }
});

test('완료 저장 오류는 연습 목록에 남아 재시도할 수 있고, 실제 AI 처리 중에는 완료하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-recovery-'));
  try {
    const store = new TutorialStore(dir);
    const user = { name: '연습자', role: 'editor' };
    const meta = store.create({ fileName: '연습.hwpx', bytes: Buffer.from('test-only'), by: user.name,
      extra: { tutorial: true, tutorialId: 'report', tutorialSession: true, tutorialOwnerKey: tutorialOwnerKey(user) } });
    const tutorial = createTutorial({ config: { root, dataDir: dir }, service: { store, hub: { broadcast() {} }, tutorialAiStatus() { return {}; } } });
    meta.requests.push({ rid: 1, status: 'working', example: true }); store.saveMeta(meta);
    await assert.rejects(tutorial.complete(user, meta.id), e => e.code === 'TUTORIAL_BUSY');
    assert.deepEqual(store.list(), []);
    meta.requests[0].status = 'done'; store.saveMeta(meta);
    const original = store.promoteTutorial.bind(store);
    let fail = true;
    store.promoteTutorial = id => { original(id); if (fail) { fail = false; throw new Error('시험용 저장 중단'); } };
    await assert.rejects(tutorial.complete(user, meta.id), /시험용 저장 중단/);
    assert.deepEqual(store.list(), [], '폴더를 옮긴 뒤 오류가 나도 완료하지 않은 문서를 공개하지 않는다');
    assert.equal(tutorial.status(user).sessions[0].docId, meta.id);
    assert.equal((await tutorial.complete(user, meta.id)).saved, true);
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.listSessions(), []);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
