import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { prepareTutorialEntry } from '../web/tutorial-entry.js';

test('인증 직후 준비가 끝나기 전에는 화면을 선택하지 않고 미완료 결과보고서로 바로 간다', async () => {
  const first = { tutorial: true, tutorialIntroRequired: true };
  for (const route of ['#/', '#/doc/shared-report', '#/admin', '#/tutorial']) {
    let resolve; const ready = new Promise(r => { resolve = r; });
    let called = false;
    const entry = prepareTutorialEntry(first, route, async (url, options) => {
      called = true; assert.equal(url, '/api/tutorial/entry'); assert.equal(options.method, 'POST');
      return ready;
    });
    assert.equal(called, true);
    resolve({ docId: 'report-session' });
    assert.deepEqual(await entry, { route: '#/doc/report-session', introDocId: 'report-session' });
  }
  const noRequest = () => { throw new Error('완료한 토큰은 새 문서를 만들지 않는다'); };
  assert.deepEqual(await prepareTutorialEntry({ tutorial: true, tutorialIntroRequired: false }, '#/', noRequest), { route: '#/' });
  assert.deepEqual(await prepareTutorialEntry({ tutorial: false, tutorialIntroRequired: true }, '#/admin', noRequest), { route: '#/admin' });
  assert.deepEqual(await prepareTutorialEntry(first, '#/', async () => ({ skipped: true })), { route: '#/' });
});

test('메뉴 방문·옛 시작 기록과 무관하게 미완료 토큰은 보고서를 재사용하고 단계는 서버에 남긴다', async () => {
  const srv = await startServer({ config: { tutorial: { autoStart: false } } });
  try {
    let A = srv.api('a');
    const seen = path.join(srv.dataDir, 'tutorial-seen.json');
    fs.writeFileSync(seen, JSON.stringify({ [srv.users.a.name]: { at: '2026-10-31T00:00:00.000Z', how: 'auto', menuVisitedAt: '2026-11-01T00:00:00.000Z' } }));
    await A('/api/tutorial/visit', { method: 'POST', body: {} });
    assert.equal((await A('/api/me')).tutorialIntroRequired, true);
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'tutorial-sessions/docs')), [], 'GET me에는 사본을 만들지 않는다');
    const entries = await Promise.all([1, 2, 3].map(() => A('/api/tutorial/entry', { method: 'POST', body: {} })));
    assert.equal(new Set(entries.map(e => e.docId)).size, 1, '동시에 접속한 여러 탭도 같은 연습 문서');
    const { docId } = entries[0];
    assert.equal((await A(`/api/docs/${docId}`)).tutorialId, 'report');
    await A(`/api/tutorial/${docId}/progress`, { method: 'PUT', body: { i: 9, ctx: { memoId: 'm1', rid1: 3 } } });
    assert.deepEqual((await A('/api/library')).docs, []);
    await srv.restart(); A = srv.api('a');
    assert.equal((await A('/api/me')).tutorialIntroRequired, true, '재접속해도 완료 전에는 시작 안내');
    assert.equal((await A('/api/tutorial/entry', { method: 'POST', body: {} })).docId, docId);
    assert.deepEqual(await A(`/api/tutorial/${docId}/progress`), { docId, i: 9, ctx: { memoId: 'm1', rid1: 3 } });
    assert.equal((await srv.api('b')('/api/me')).tutorialIntroRequired, true);
    assert.equal((await srv.api('admin')('/api/me')).tutorialIntroRequired, true);
  } finally { await srv.stop(); }
});

test('버린 연습은 새 보고서로 시작, 결과보고서 완료 후에는 문서를 삭제해도 재접속 강제 안내를 끝낸다', async () => {
  const srv = await startServer();
  try {
    let A = srv.api('a');
    const first = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    await A(`/api/tutorial/${first.docId}`, { method: 'DELETE' });
    const next = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    assert.notEqual(next.docId, first.docId);
    const other = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'overview' } });
    await A(`/api/tutorial/${other.docId}/complete`, { method: 'POST', body: {} });
    assert.equal((await A('/api/me')).tutorialIntroRequired, true, '다른 안내 완료로 결과보고서를 완료 처리하지 않는다');
    const completed = await A(`/api/tutorial/${next.docId}/complete`, { method: 'POST', body: {} });
    assert.equal((await A('/api/me')).tutorialIntroRequired, false);
    assert.equal((await A(`/api/tutorial/${next.docId}/complete`, { method: 'POST', body: {} })).completedAt, completed.completedAt);
    await A(`/api/docs/${next.docId}`, { method: 'DELETE' });
    await srv.restart(); A = srv.api('a');
    assert.equal((await A('/api/me')).tutorialIntroRequired, false, '완료 이력은 완료 문서 삭제와 무관하게 남긴다');
    assert.deepEqual(await A('/api/tutorial/entry', { method: 'POST', body: {} }), { skipped: true });
    const replay = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } });
    assert.ok(replay.docId, '완료 후에도 메뉴에서 새로 연습할 수 있다');
    assert.equal((await A('/api/me')).tutorialIntroRequired, false);
    const ledger = fs.readFileSync(path.join(srv.dataDir, 'tutorial-state.json'), 'utf8');
    assert.ok(!ledger.includes(srv.tokens.a), '서버 기록에도 원문 토큰을 쓰지 않는다');
  } finally { await srv.stop(); }
});

test('같은 이름이라도 서로 다른 토큰의 연습·진행·완료 기록은 격리한다', async () => {
  const srv = await startServer({ users: [{ name: '관리자', role: 'admin' }, { name: '같은이름' }, { name: '같은이름' }] });
  try {
    const A = srv.api('a'); const B = srv.api('b');
    const a = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    const b = await B('/api/tutorial/entry', { method: 'POST', body: {} });
    assert.notEqual(a.docId, b.docId);
    assert.equal((await B.res(`/api/docs/${a.docId}`)).status, 404);
    assert.equal((await B.res(`/api/tutorial/${a.docId}/progress`)).status, 404);
    assert.equal((await B.res(`/api/tutorial/${a.docId}/progress`, { method: 'PUT', body: { i: 2, ctx: {} } })).status, 404);
    assert.equal((await B.res(`/api/tutorial/${a.docId}/complete`, { method: 'POST', body: {} })).status, 404);
    assert.equal((await B.res(`/api/tutorial/${a.docId}`, { method: 'DELETE' })).status, 404);
    assert.deepEqual((await B('/api/tutorial')).sessions.map(s => s.docId), [b.docId]);
    await A(`/api/tutorial/${a.docId}/complete`, { method: 'POST', body: {} });
    assert.equal((await A('/api/me')).tutorialIntroRequired, false);
    assert.equal((await B('/api/me')).tutorialIntroRequired, true);
    await srv.restart();
    assert.equal((await srv.api('a')('/api/me')).tutorialIntroRequired, false);
    assert.equal((await srv.api('b')('/api/me')).tutorialIntroRequired, true);
  } finally { await srv.stop(); }
});

test('새로 발급한 토큰은 이름이 같아도 새 사용자 — 결과보고서부터 다시 안내하고 이전 토큰의 연습을 넘겨받지 않는다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const report = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    await A(`/api/tutorial/${report.docId}/complete`, { method: 'POST', body: {} });
    const open = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'overview' } });
    // 토큰별 기록 이전에 만든 연습(소유 토큰 표시 없음)은 서버를 켤 때 지금 토큰에 한 번 묶는다
    const metaFile = path.join(srv.dataDir, 'tutorial-sessions', 'docs', open.docId, 'meta.json');
    const legacy = JSON.parse(fs.readFileSync(metaFile, 'utf8')); delete legacy.tutorialOwnerKey;
    fs.writeFileSync(metaFile, JSON.stringify(legacy));
    await srv.restart();
    assert.deepEqual((await srv.api('a')('/api/tutorial')).sessions.map(s => s.docId), [open.docId]);
    assert.ok(JSON.parse(fs.readFileSync(metaFile, 'utf8')).tutorialOwnerKey);
    assert.equal((await srv.api('a')('/api/me')).tutorialIntroRequired, false);
    // 관리자가 같은 이름에 새 토큰을 발급했다
    const cfg = JSON.parse(fs.readFileSync(srv.configPath, 'utf8'));
    const fresh = `fresh-${Date.now()}`;
    cfg.users.find(u => u.name === srv.users.a.name).token = fresh;
    fs.writeFileSync(srv.configPath, JSON.stringify(cfg, null, 1));
    await srv.restart();
    const N = srv.api(fresh);
    assert.equal((await N('/api/me')).tutorialIntroRequired, true, '새 토큰은 결과보고서를 완료하지 않은 새 사용자');
    assert.deepEqual((await N('/api/tutorial')).sessions, [], '이전 토큰의 진행 중 연습은 보이지 않는다');
    assert.equal((await N.res(`/api/tutorial/${open.docId}/progress`)).status, 404);
    const entry = await N('/api/tutorial/entry', { method: 'POST', body: {} });
    assert.ok(entry.docId && entry.docId !== report.docId && entry.docId !== open.docId);
  } finally { await srv.stop(); }
});

test('새 진입·진행 API는 인증과 유효한 단계가 필요하며 비활성 계정은 진입하지 않는다', async () => {
  const srv = await startServer({ config: { tutorial: { everyone: false, users: ['홍길동'] } } });
  try {
    assert.equal((await srv.api(null).res('/api/tutorial/entry', { method: 'POST', body: {} })).status, 401);
    assert.equal((await srv.api('b').res('/api/tutorial/entry', { method: 'POST', body: {} })).status, 403);
    assert.ok(!(await srv.api('b')('/api/me')).tutorialIntroRequired);
    const A = srv.api('a'); const { docId } = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    for (const invalid of [{ i: -1, ctx: {} }, { i: 1.5, ctx: {} }, { i: 10001, ctx: {} }, { i: 1, ctx: [] }, { i: 1, ctx: { long: 'a'.repeat(33000) } }])
      assert.equal((await A.res(`/api/tutorial/${docId}/progress`, { method: 'PUT', body: invalid })).status, 400);
    assert.deepEqual(await A(`/api/tutorial/${docId}/progress`), { docId, i: 0, ctx: {} });
    await A(`/api/tutorial/${docId}/complete`, { method: 'POST', body: {} });
    assert.equal((await A.res(`/api/tutorial/${docId}/progress`, { method: 'PUT', body: { i: 2, ctx: {} } })).status, 409);
  } finally { await srv.stop(); }
});
