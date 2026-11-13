// PC 폴더 연결·함께 검토(server/local-folders.js, docs/LOCAL_FOLDER_APP_2026-11-10.md) — 임시 서버·임시 PC 폴더로 확인한다.
//   node --test tests/local_folders.test.mjs
// 쓰기 잠김은 한/글 대신 같은 꼴로 파일을 열어 둔 프로세스로 흉내 낸다(Windows). Windows 휴지통·폴더 고르기 창은 여기서 다루지 않는다(휴지통 대신 HWPX_COWORK_LOCAL_TRASH 폴더).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HwpxDoc } from '../engine/doc.js';
import { startServer, fixture } from './helpers/server.mjs';
import { walkFolder, safeName } from '../server/local-folders.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BASE = fs.readFileSync(fixture('hangul_trk_brk_base.hwpx'));
const OTHER = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));
const THIRD = fs.readFileSync(fixture('hangul_resaved_dedup.hwpx'));

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(60); }
  throw new Error(`기다리다 시간 초과: ${what} (${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** 임시 PC 폴더 + PC 폴더 연결을 켠 서버. 지운 파일은 trash 폴더로(휴지통을 건드리지 않는다) */
async function setup(t, { writeDelayMs = 40, link = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-pc-'));
  const pc = path.join(tmp, '내 문서');
  const trash = path.join(tmp, 'trash');
  fs.mkdirSync(path.join(pc, '하위'), { recursive: true });
  fs.mkdirSync(path.join(pc, '빈 폴더'));
  fs.mkdirSync(path.join(pc, '기타'));
  fs.writeFileSync(path.join(pc, '보고서.hwpx'), BASE);
  fs.writeFileSync(path.join(pc, '하위', '둘째.hwpx'), OTHER);
  fs.writeFileSync(path.join(pc, '기타', '메모.txt'), 'HWPX 가 아닌 파일');
  fs.writeFileSync(path.join(pc, '~$보고서.hwpx'), 'lock');
  const srv = await startServer({ config: { local: { enabled: true, writeDelayMs } }, env: { HWPX_COWORK_LOCAL_TRASH: trash } });
  t.after(async () => { await srv.stop(); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 남겨도 됨 */ } });
  const A = srv.api('admin');
  let linked = null;
  if (link) linked = (await A('/api/local/links', { method: 'POST', body: { path: pc } })).link;
  const lib = () => A('/api/library');
  // 탐색기에서 바꾼 것을 곧바로 보려면 다시 훑는다(목록은 1.5초 안에 다시 훑지 않는다)
  const relist = async () => { await A('/api/local/rescan', { method: 'POST' }); return lib(); };
  const docBy = async (name) => (await lib()).docs.find((d) => d.fileName === name);
  return { srv, A, pc, trash, tmp, linked, lib, relist, docBy };
}

test('walkFolder·safeName: HWPX 가 있는 폴더와 빈 폴더만, 임시·숨김 파일은 건너뛴다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-walk-'));
  try {
    fs.mkdirSync(path.join(tmp, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'empty'));
    fs.mkdirSync(path.join(tmp, 'other'));
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'x.HWPX'), 'x');
    fs.writeFileSync(path.join(tmp, 'other', 'note.txt'), 'x');
    fs.writeFileSync(path.join(tmp, '.git', 'y.hwpx'), 'x');
    fs.writeFileSync(path.join(tmp, '~$z.hwpx'), 'x');
    const w = walkFolder(tmp);
    assert.deepEqual(w.dirs.sort(), ['a', 'a/b', 'empty']);
    assert.deepEqual(w.files.map((f) => f.rel), ['a/b/x.HWPX']);
    assert.equal(w.truncated, false);
    // 건너뛸 폴더(이 앱의 프로그램·데이터 폴더 — 앱을 풀어 둔 폴더의 위를 연결했을 때 그 안의 기록 파일이 문서로 보이지 않게)
    const skipped = walkFolder(tmp, { skip: (abs) => abs === path.join(tmp, 'a', 'b') });
    assert.deepEqual(skipped.files, []);
    assert.deepEqual(skipped.dirs, ['empty'], '건너뛴 폴더만 든 폴더(a)는 HWPX 가 없는 폴더라 보이지 않는다');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(safeName('보고서: 1/2?', 'x'), '보고서_ 1_2_');
  assert.equal(safeName('  끝 점. . ', 'x'), '끝 점');
  assert.equal(safeName('CON', '문서'), '문서');
  assert.equal(safeName('', null), null);
});

test('연결: 관리자만, 이 PC 의 폴더만 — 문서함에 폴더와 파일이 보이고 열기 전에는 서버에 복사하지 않는다', async (t) => {
  const { srv, A, pc, linked, lib } = await setup(t, { link: false });
  const U = srv.api('a');
  assert.equal((await srv.api(null)('/api/config')).local, true);
  assert.equal((await U.res('/api/local/links', { method: 'POST', body: { path: pc } })).status, 403, '관리자가 아니면 연결하지 못한다');
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: pc }, headers: { 'X-Forwarded-For': '203.0.113.5' } })).status, 403, '프록시를 거친 요청은 받지 않는다');
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: 'relative/path' } })).data.error, 'BAD_PATH');
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: path.join(pc, '없는 폴더') } })).status, 404);
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: path.parse(pc).root } })).data.error, 'BAD_PATH', '드라이브 전체는 연결하지 않는다');
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: srv.dataDir } })).data.error, 'BAD_PATH', '앱 데이터 폴더는 연결하지 않는다');
  assert.equal(linked, null);

  const out = await A('/api/local/links', { method: 'POST', body: { path: pc } });
  assert.equal(out.link.name, '내 문서');
  assert.equal(out.local.links.length, 1);
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: pc } })).data.error, 'LINKED');
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: path.join(pc, '하위') } })).data.error, 'LINK_OVERLAP');

  const v = await lib();
  assert.equal(v.local.canLink, true);
  assert.equal(v.local.links[0].path, pc);
  const root = v.folders.find((f) => f.id === out.link.folderId);
  assert.ok(root && root.space === 'private' && root.local.root === true && root.parentId === null, '연결한 폴더는 개인 문서함 맨 위에');
  assert.deepEqual(v.folders.filter((f) => f.local && !f.local.root).map((f) => f.name).sort(), ['빈 폴더', '하위'], 'HWPX 가 없는 폴더(기타)는 보이지 않는다');
  const docs = v.docs.filter((d) => d.local);
  assert.deepEqual(docs.map((d) => d.fileName).sort(), ['둘째.hwpx', '보고서.hwpx'], '~$ 잠금 파일은 건너뛴다');
  for (const d of docs) { assert.equal(d.local.state, 'file'); assert.equal(d.version, 0); assert.ok(d.perms.includes('edit')); assert.ok(d.local.path.startsWith(pc)); }
  assert.equal(docs.find((d) => d.fileName === '둘째.hwpx').folderId, v.folders.find((f) => f.name === '하위').id);
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'docs')).length, 0, '열기 전에는 서버 데이터 폴더에 문서가 없다');

  // 다른 사람에게는 보이지 않는다(주인의 개인 문서함) — 그 id 로 불러도 없는 문서
  const other = await U('/api/library');
  assert.equal(other.docs.filter((d) => d.local).length, 0);
  assert.equal(other.local.canLink, false);
  assert.deepEqual(other.local.links, []);
  const report = docs.find((d) => d.fileName === '보고서.hwpx');
  assert.equal((await U.res(`/api/docs/${report.id}`)).status, 404);
  assert.equal(fs.readdirSync(path.join(srv.dataDir, 'docs')).length, 0, '볼 수 없는 사람이 불러도 등록하지 않는다');
});

test('열기 → 고치기 → PC 파일에 저장, 밖에서 바뀐 파일은 다시 읽는다(PC 파일이 기준)', async (t) => {
  const { srv, A, pc, docBy } = await setup(t);
  const file = path.join(pc, '보고서.hwpx');
  const pseudo = await docBy('보고서.hwpx');
  const info = await A(`/api/docs/${pseudo.id}`);
  assert.equal(info.id, pseudo.id, '목록의 id 그대로 등록된다');
  assert.equal(info.version, 1);
  assert.equal(info.local.state, 'ok');
  assert.equal(info.space, 'private');
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'docs', pseudo.id, 'current.hwpx')));
  assert.ok(fs.readFileSync(file).equals(BASE), '열기만 해서는 PC 파일을 건드리지 않는다');

  // 고치기(메모 달기 = 커밋) → PC 파일 = 서버의 지금 기록과 같은 바이트
  await A(`/api/docs/${pseudo.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '첫째', text: 'PC 폴더 시험 메모' } });
  const saved = await until(async () => { const b = fs.readFileSync(file); return b.equals(BASE) ? null : b; }, 'PC 파일에 쓰기');
  const current = await A(`/api/docs/${pseudo.id}/file?kind=tracked`);
  assert.ok(saved.equals(current), 'PC 파일과 서버 기록이 같은 바이트');
  assert.equal((await HwpxDoc.load(saved)).memos().length, 1, '한/글에서 열면 메모가 보이는 파일');
  await until(async () => (await A(`/api/docs/${pseudo.id}`)).local.state === 'ok', '저장 표시');

  // 편집기에서 글을 고침(실시간 밀어 넣기 — 편집기 내보내기 자리) → PC 파일의 글이 바뀐다(실시간·고친 글만: 변경 추적 없이)
  const w = await A.res(`/api/docs/${pseudo.id}/file?kind=working`);
  const head = await (await HwpxDoc.load(w.data)).clone();
  head.mergeParagraphText('s0/p0', '첫째 문단을 편집기에서 고쳤습니다.', { author: '관리자' });
  const pushed = await A.res(`/api/docs/${pseudo.id}/live?base=${w.headers.get('x-doc-version')}`, { method: 'PUT', body: Buffer.from(await (await head.flattened()).save()) });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  const typed = await until(async () => { const d = await HwpxDoc.load(fs.readFileSync(file)); return d.text('s0/p0', 'final') === '첫째 문단을 편집기에서 고쳤습니다.' ? d : null; }, '편집기에서 고친 글을 PC 파일에 쓰기');
  assert.equal(typed.changes().length, 0, '고친 글만(변경 추적 없음)');
  assert.equal(typed.memos().length, 1, '메모는 그대로');
  const savedTyped = fs.readFileSync(file);
  assert.deepEqual(fs.readdirSync(pc).filter((n) => n.includes('cowork')), [], '임시 파일을 남기지 않는다');

  // 밖에서 바꿈(한/글에서 저장한 것처럼 다른 내용으로 덮어씀) → 새 기록으로 통째로 읽는다. PC 파일은 그대로
  const before = (await A(`/api/docs/${pseudo.id}`)).version;
  fs.writeFileSync(file, OTHER);
  const after = await until(async () => { const d = await A(`/api/docs/${pseudo.id}`); return d.version > before ? d : null; }, '밖에서 바뀐 파일 읽기');
  assert.equal(after.local.state, 'ok');
  assert.ok(after.formatVersion === after.version, '열린 편집기가 다시 열도록 서식 판을 올린다');
  const paras = await A(`/api/docs/${pseudo.id}/paragraphs`);
  assert.ok(paras.some((p) => p.text.includes('메모 대상 문장')), '새 파일의 글');
  const hist = await A(`/api/docs/${pseudo.id}/history`);
  assert.ok(JSON.stringify(hist).includes('PC 파일에서 다시 읽음'));
  await sleep(200);
  assert.ok(fs.readFileSync(file).equals(OTHER), '다시 읽은 뒤 PC 파일을 고쳐 쓰지 않는다');
  assert.ok((await A(`/api/docs/${pseudo.id}/file?kind=tracked`)).equals(OTHER), '기록도 그 파일 바이트 그대로');
  // 그 전 내용(메모를 단 판)은 이력에 남아 있다
  assert.ok((await A(`/api/docs/${pseudo.id}/file?kind=version&n=${before}`)).equals(savedTyped));

  // 읽을 수 없는 파일로 바뀌면 문서는 그대로 두고 표시만 한다 — 고쳐 쓰지도 않는다
  fs.writeFileSync(file, Buffer.from('이것은 HWPX 가 아닙니다'));
  const bad = await until(async () => { const d = await A(`/api/docs/${pseudo.id}`); return d.local.state === 'unreadable' ? d : null; }, '읽을 수 없는 파일 표시');
  assert.equal(bad.version, after.version);
  await A(`/api/docs/${pseudo.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '첫째', text: '못 읽는 동안 단 메모' } });
  await sleep(300);
  assert.equal(fs.readFileSync(file, 'utf8'), '이것은 HWPX 가 아닙니다', '밖에서 바뀐 파일을 덮어쓰지 않는다');
  // 제대로 된 파일로 돌아오면 다시 읽는다
  fs.writeFileSync(file, THIRD);
  await until(async () => { const d = await A(`/api/docs/${pseudo.id}`); return d.local.state === 'ok' && (await A(`/api/docs/${pseudo.id}/file?kind=tracked`)).equals(THIRD); }, '고친 파일 다시 읽기');
});

test('PC 폴더 안에서 새 문서·올리기·이름 바꾸기·옮기기·지우기 = PC 파일에 그대로', async (t) => {
  const { srv, A, pc, trash, linked, lib } = await setup(t);
  const v0 = await lib();
  const sub = v0.folders.find((f) => f.name === '하위');
  // 새 문서로 시작
  const made = await A('/api/library/docs', { method: 'POST', body: { title: '새 문서', folderId: linked.folderId } });
  assert.equal(made.title, '새 문서');
  assert.ok(fs.existsSync(path.join(pc, '새 문서.hwpx')));
  assert.equal(made.local.state, 'ok');
  const again = await A('/api/library/docs', { method: 'POST', body: { title: '새 문서', folderId: linked.folderId } });
  assert.equal(again.title, '새 문서 (2)');
  assert.ok(fs.existsSync(path.join(pc, '새 문서 (2).hwpx')));
  // 올리기(하위 폴더로) — 같은 이름이 있으면 (2)
  const up = await A('/api/docs', { method: 'POST', body: THIRD, headers: { 'x-file-name': encodeURIComponent('둘째.hwpx'), 'x-folder-id': sub.id } });
  assert.equal(up.fileName, '둘째 (2).hwpx');
  assert.ok(fs.readFileSync(path.join(pc, '하위', '둘째 (2).hwpx')).equals(THIRD));
  // 이름 바꾸기 = 파일 이름 바꾸기(못 쓰는 글자는 _)
  const renamed = await A(`/api/docs/${made.id}`, { method: 'PATCH', body: { title: '계획: 1차' } });
  assert.equal(renamed.title, '계획_ 1차');
  assert.ok(fs.existsSync(path.join(pc, '계획_ 1차.hwpx')) && !fs.existsSync(path.join(pc, '새 문서.hwpx')));
  assert.equal((await A.res(`/api/docs/${made.id}`, { method: 'PATCH', body: { title: '새 문서 (2)' } })).data.error, 'NAME_TAKEN');
  // 옮기기(PC 폴더 안) = 파일 옮기기. 서버 문서함으로는 옮기지 않는다
  const moved = await A(`/api/docs/${made.id}/location`, { method: 'PATCH', body: { folderId: sub.id } });
  assert.equal(moved.folderId, sub.id);
  assert.ok(fs.existsSync(path.join(pc, '하위', '계획_ 1차.hwpx')) && !fs.existsSync(path.join(pc, '계획_ 1차.hwpx')));
  assert.equal((await A.res(`/api/docs/${made.id}/location`, { method: 'PATCH', body: { space: 'public' } })).data.error, 'LOCAL_ONLY');
  // 서버 문서함의 문서를 PC 폴더로 옮기면 파일이 생기고 이어진다
  const server = await A('/api/docs', { method: 'POST', body: BASE, headers: { 'x-file-name': encodeURIComponent('서버 문서.hwpx') } });
  assert.equal(server.local, undefined);
  const attached = await A(`/api/docs/${server.id}/location`, { method: 'PATCH', body: { folderId: linked.folderId } });
  assert.equal(attached.local.state, 'ok');
  assert.ok(fs.readFileSync(path.join(pc, '서버 문서.hwpx')).equals(BASE));
  // 이어진 뒤 고치면 그 파일에 쓴다
  await A(`/api/docs/${server.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '첫째', text: '이은 뒤 메모' } });
  await until(async () => !fs.readFileSync(path.join(pc, '서버 문서.hwpx')).equals(BASE), '이은 문서의 PC 파일 쓰기');
  // 지우기 = PC 파일도 지운다(여기서는 trash 폴더로 — 완전히 지우지 않는다)
  await A(`/api/docs/${again.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(path.join(pc, '새 문서 (2).hwpx')));
  assert.equal(fs.readdirSync(trash).filter((n) => n.endsWith('새 문서 (2).hwpx')).length, 1);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'docs', again.id)));
  // 아직 열지 않은 파일 지우기: 등록하지 않고 파일만 지운다
  const pseudo = (await lib()).docs.find((d) => d.fileName === '보고서.hwpx');
  assert.equal(pseudo.local.state, 'file');
  await A(`/api/docs/${pseudo.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(path.join(pc, '보고서.hwpx')) && !fs.existsSync(path.join(srv.dataDir, 'docs', pseudo.id)));
  assert.ok(!(await lib()).docs.some((d) => d.id === pseudo.id));
});

test('폴더: 만들기·이름 바꾸기·지우기가 PC 폴더에 그대로, 탐색기에서 옮긴 파일은 같은 문서로 잇는다', async (t) => {
  const { A, pc, linked, lib, relist, docBy } = await setup(t);
  // 폴더 만들기
  const f = await A('/api/folders', { method: 'POST', body: { name: '새 폴더', parentId: linked.folderId } });
  assert.ok(fs.statSync(path.join(pc, '새 폴더')).isDirectory());
  assert.equal(f.local.root, false);
  assert.equal((await A.res('/api/folders', { method: 'POST', body: { name: '하위', parentId: linked.folderId } })).status, 409);
  // 하위 폴더의 문서를 열어 등록해 둔다
  const second = await docBy('둘째.hwpx');
  await A(`/api/docs/${second.id}`);
  const sub = (await lib()).folders.find((x) => x.name === '하위');
  await A(`/api/folders/${sub.id}/access`, { method: 'PUT', body: { acl: [{ name: '홍길동', perms: ['read'] }] } });
  // 폴더 이름 바꾸기 = PC 폴더 이름 바꾸기. 안의 문서는 같은 id 로 이어지고 권한도 따라간다
  const renamed = await A(`/api/folders/${sub.id}`, { method: 'PATCH', body: { name: '보관' } });
  assert.equal(renamed.name, '보관');
  assert.ok(fs.existsSync(path.join(pc, '보관', '둘째.hwpx')) && !fs.existsSync(path.join(pc, '하위')));
  const v = await lib();
  const kept = v.docs.find((d) => d.id === second.id);
  assert.ok(kept, '옮긴 폴더의 문서는 같은 문서');
  assert.equal(kept.folderId, renamed.id);
  assert.equal(kept.local.state, 'ok');
  assert.deepEqual(v.folders.find((x) => x.id === renamed.id).acl, [{ name: '홍길동', perms: ['read'] }]);
  assert.ok(!v.docs.some((d) => d.fileName === '둘째.hwpx' && d.id !== second.id), '같은 파일이 두 번 보이지 않는다');
  // 탐색기에서 파일 이름을 바꿈·다른 폴더로 옮김 → 내용이 같으면 같은 문서(제목도 새 파일 이름으로)
  fs.renameSync(path.join(pc, '보관', '둘째.hwpx'), path.join(pc, '새 폴더', '최종본.hwpx'));
  const v2 = await relist();
  const same = v2.docs.find((d) => d.id === second.id);
  assert.ok(same, '탐색기에서 옮긴 파일도 같은 문서');
  assert.equal(same.title, '최종본'); assert.equal(same.fileName, '최종본.hwpx'); assert.equal(same.folderId, f.id);
  // 지우기: 빈 폴더만. 연결한 폴더 자체는 지우지 않는다(연결 끊기)
  assert.equal((await A.res(`/api/folders/${f.id}`, { method: 'DELETE' })).status, 409);
  const emptied = v2.folders.find((x) => x.id === renamed.id);
  await A(`/api/folders/${emptied.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(path.join(pc, '보관')));
  assert.equal((await A.res(`/api/folders/${linked.folderId}`, { method: 'DELETE' })).data.error, 'LOCAL_ROOT');
  // 탐색기에서 지운 파일의 문서는 목록에서 숨는다(기록은 남는다)
  fs.unlinkSync(path.join(pc, '새 폴더', '최종본.hwpx'));
  assert.ok(!(await relist()).docs.some((d) => d.id === second.id));
});

test('연결 끊기·다시 연결, 공유, 서버를 다시 켠 뒤 못 쓴 기록 마저 쓰기', async (t) => {
  const { srv, A, pc, linked, lib, docBy } = await setup(t, { writeDelayMs: 600000 });   // 쓰기를 미뤄 '끄기 전에 못 쓴 기록'을 만든다
  const U = srv.api('a');
  const report = await docBy('보고서.hwpx');
  await A(`/api/docs/${report.id}`);
  // 폴더 권한으로 다른 사람과 공유(내 서버에 접속한 사람) — 그 사람이 열어도 된다
  await A(`/api/folders/${linked.folderId}/access`, { method: 'PUT', body: { acl: [{ name: '홍길동', perms: ['read', 'edit'] }] } });
  const shared = await U('/api/library');
  assert.ok(shared.docs.some((d) => d.id === report.id) && shared.docs.some((d) => d.fileName === '둘째.hwpx'));
  assert.equal(shared.docs.find((d) => d.id === report.id).local.path, undefined, '다른 사람에게 PC 경로는 알리지 않는다');
  const second = shared.docs.find((d) => d.fileName === '둘째.hwpx');
  assert.equal((await U(`/api/docs/${second.id}`)).version, 1, '공유받은 사람이 처음 열어도 등록된다');
  // 고친 뒤 곧바로 서버가 죽는다(쓰기 전) → 다시 켜면 PC 파일에 마저 쓴다
  await U(`/api/docs/${report.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '첫째', text: '끄기 전 메모' } });
  assert.equal((await A(`/api/docs/${report.id}`)).local.state, 'saving');
  assert.ok(fs.readFileSync(path.join(pc, '보고서.hwpx')).equals(BASE));
  await srv.restart();
  await A('/api/library');
  await until(async () => !fs.readFileSync(path.join(pc, '보고서.hwpx')).equals(BASE), '다시 켠 뒤 PC 파일 쓰기');
  assert.ok(fs.readFileSync(path.join(pc, '보고서.hwpx')).equals(await A(`/api/docs/${report.id}/file?kind=tracked`)));
  // 연결 끊기: 문서함에서 사라지지만 PC 파일과 앱 기록은 그대로
  await A(`/api/local/links/${linked.id}`, { method: 'DELETE' });
  const off = await lib();
  assert.equal(off.folders.filter((f) => f.local).length, 0);
  assert.equal(off.docs.filter((d) => d.local).length, 0);
  assert.ok(fs.existsSync(path.join(pc, '보고서.hwpx')) && fs.existsSync(path.join(srv.dataDir, 'docs', report.id, 'meta.json')));
  // 다시 연결하면 같은 문서(이력 포함)로 이어진다
  await A('/api/local/links', { method: 'POST', body: { path: pc } });
  const on = await lib();
  const back = on.docs.find((d) => d.id === report.id);
  assert.ok(back && back.version >= 2 && back.local.state === 'ok');
});

test('다른 프로그램이 PC 파일을 열어 둔 동안(쓰기 잠김)에는 기다렸다가, 닫으면 저장한다', { skip: process.platform !== 'win32' && '쓰기 잠김은 Windows 에서만 흉내 낸다' }, async (t) => {
  const { A, pc, relist, docBy } = await setup(t);
  const file = path.join(pc, '보고서.hwpx');
  const report = await docBy('보고서.hwpx');
  await A(`/api/docs/${report.id}`);
  // 한/글처럼 읽기만 나누고(쓰기·바꿔 끼우기 불가) 파일을 열어 둔 프로세스
  const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [System.IO.File]::Open($env:HWPX_LOCK_FILE, 'Open', 'ReadWrite', 'Read'); [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null; $f.Close(); [Console]::Out.WriteLine('RELEASED')"],
  { env: { ...process.env, HWPX_LOCK_FILE: file }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { try { holder.kill(); } catch { /* 이미 끝남 */ } });
  const said = [];
  holder.stdout.setEncoding('utf8'); holder.stdout.on('data', (s) => said.push(s));
  await until(() => said.join('').includes('LOCKED'), '파일 잠금', 20000);
  await A(`/api/docs/${report.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '첫째', text: '잠긴 동안 단 메모' } });
  const locked = await until(async () => { const d = await A(`/api/docs/${report.id}`); return d.local.state === 'locked' ? d : null; }, '쓰기 대기 표시');
  assert.equal(locked.version, 2, '문서(앱 기록)는 고쳐졌다');
  assert.ok(fs.readFileSync(file).equals(BASE), '잠긴 동안 PC 파일은 그대로');
  assert.deepEqual(fs.readdirSync(pc).filter((n) => n.includes('cowork')), [], '임시 파일을 남기지 않는다');
  // 닫으면: 목록을 다시 읽을 때 곧바로(또는 5초마다 다시 해 볼 때) 저장한다
  holder.stdin.write('\n');
  await until(() => said.join('').includes('RELEASED'), '잠금 풀림', 20000);
  await relist();
  await until(async () => !fs.readFileSync(file).equals(BASE), '잠금이 풀린 뒤 PC 파일 쓰기');
  assert.ok(fs.readFileSync(file).equals(await A(`/api/docs/${report.id}/file?kind=tracked`)));
  await until(async () => (await A(`/api/docs/${report.id}`)).local.state === 'ok', '저장됨 표시');
});

test('함께 검토: 중앙 서버에 보내고 검토본을 가져와 PC 파일에 쓴다', async (t) => {
  const { A, pc, docBy } = await setup(t);
  const central = await startServer();
  t.after(() => central.stop());
  const C = central.api('a');   // 중앙 서버에서의 나(홍길동)
  const report = await docBy('보고서.hwpx');
  // 검토 서버 등록: 주소·토큰을 그 서버에 확인한 뒤 저장(토큰은 돌려주지 않는다)
  assert.equal((await A.res('/api/local/remotes', { method: 'POST', body: { url: central.base, token: 'wrong-token' } })).data.error, 'REMOTE_AUTH');
  assert.equal((await A.res('/api/local/remotes', { method: 'POST', body: { url: 'http://127.0.0.1:1', token: 'x' } })).data.error, 'REMOTE_UNREACHABLE');
  const reg = await A('/api/local/remotes', { method: 'POST', body: { url: `${central.base}/mcp`, token: central.tokens.a, name: '중앙 서버' } });
  assert.equal(reg.remote.user, '홍길동'); assert.equal(reg.remote.url, central.base); assert.equal(reg.remote.token, undefined);
  assert.ok(!JSON.stringify(await A('/api/local')).includes(central.tokens.a), '저장한 토큰은 목록에 싣지 않는다');
  const opened = await A(`/api/local/remotes/${reg.remote.id}/open`);
  assert.equal(opened.url, `${central.base}/#/t/${central.tokens.a}`);
  // 보내기(아직 열지 않은 PC 파일도 그 자리에서 등록해 보낸다)
  const sent = await A(`/api/docs/${report.id}/review/send`, { method: 'POST', body: { remote: reg.remote.id, space: 'private' } });
  assert.ok(sent.openUrl.endsWith(`/doc/${sent.review.docId}`));
  const remoteDoc = await C(`/api/docs/${sent.review.docId}`);
  assert.equal(remoteDoc.title, '보고서'); assert.equal(remoteDoc.space, 'private'); assert.equal(remoteDoc.spaceOwner, '홍길동');
  assert.equal((await A(`/api/docs/${report.id}`)).review.docId, sent.review.docId);
  let st = await A(`/api/docs/${report.id}/review`);
  assert.equal(st.remote.changed, false);
  // 중앙 서버에서 검토(메모) → 바뀜 표시 → 검토본 가져오기 → 내 문서와 PC 파일이 그 내용으로
  await C(`/api/docs/${sent.review.docId}/memos`, { method: 'POST', body: { ref: 's0/p1', find: '둘째', text: '중앙 서버에서 남긴 검토 의견' } });
  st = await A(`/api/docs/${report.id}/review`);
  assert.equal(st.remote.changed, true);
  const got = await A(`/api/docs/${report.id}/review/fetch`, { method: 'POST', body: {} });
  assert.ok(got.version >= 2 && got.review.fetchedAt);
  const memos = await A(`/api/docs/${report.id}/memos`);
  assert.ok(memos.some((m) => String(m.text).includes('중앙 서버에서 남긴 검토 의견')));
  const tracked = await C(`/api/docs/${sent.review.docId}/file?kind=tracked`);
  await until(async () => fs.readFileSync(path.join(pc, '보고서.hwpx')).equals(tracked), '검토본을 PC 파일에 쓰기');
  assert.equal((await A(`/api/docs/${report.id}/review`)).remote.changed, false);
  assert.equal(sha(fs.readFileSync(path.join(pc, '보고서.hwpx'))), sha(await A(`/api/docs/${report.id}/file?kind=tracked`)));
  // 서버 등록 지우기
  await A(`/api/local/remotes/${reg.remote.id}`, { method: 'DELETE' });
  assert.deepEqual((await A('/api/local')).remotes, []);
  assert.ok((await A(`/api/docs/${report.id}/review`)).error, '지운 서버의 상태는 오류로 알린다(문서는 그대로)');
});

test('PC 폴더 연결이 꺼진 서버(기본)에는 경로가 없다', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const A = srv.api('admin');
  assert.equal((await srv.api(null)('/api/config')).local, false);
  assert.equal((await A.res('/api/local')).status, 404);
  assert.equal((await A.res('/api/local/links', { method: 'POST', body: { path: os.tmpdir() } })).status, 404);
  assert.equal((await A('/api/library')).local, undefined);
});
