import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTutorialEntry } from '../web/tutorial-entry.js';
import { startServer } from './helpers/server.mjs';

const first = { tutorial: true, tutorialIntroRequired: true };
test('첫 결과보고서를 완료하지 않았어도 진행 연습의 새로고침 경로를 유지한다', async () => {
  const calls = [];
  const route = '#/doc/owned-practice?legacy=1';
  const entry = await prepareTutorialEntry(first, route, async (url, options) => {
    calls.push(url); assert.equal(options, undefined);
    return { tutorialSession: true };
  });
  assert.deepEqual(entry, { route });
  assert.deepEqual(calls, ['/api/docs/owned-practice']);
});

test('일반·완료·접근 불가 문서는 첫 안내 정책을 유지하며 통신 장애는 새 연습으로 바꾸지 않는다', async () => {
  for (const doc of [{ tutorialSession: false }, { tutorialSession: false, tutorialCompletedAt: 'done' }, { status: 404 }, { status: 403 }]) {
    const calls = [];
    const entry = await prepareTutorialEntry(first, '#/doc/other', async url => {
      calls.push(url);
      if (url === '/api/tutorial/entry') return { docId: 'report' };
      if (doc.status) throw Object.assign(new Error('not accessible'), doc);
      return doc;
    });
    assert.deepEqual(entry, { route: '#/doc/report', introDocId: 'report' });
    assert.deepEqual(calls, ['/api/docs/other', '/api/tutorial/entry']);
  }
  let calls = 0;
  await assert.rejects(prepareTutorialEntry(first, '#/doc/owned', async () => {
    calls++; throw Object.assign(new Error('offline'), { status: 503 });
  }), /offline/);
  assert.equal(calls, 1);
});

test('복구 후 재접속은 같은 overview 문서·단계를 열고 결과보고서를 새로 만들지 않는다', { timeout: 30000 }, async () => {
  const srv = await startServer();
  try {
    const api = srv.api('a');
    const { docId } = await api('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'overview' } });
    const progress = await api(`/api/tutorial/${docId}/progress`, { method: 'PUT', body: { i: 1, ctx: { currentStepId: 'overview-step' }, revision: 0 } });
    const restored = await api(`/api/tutorial/${docId}/restore`, { method: 'POST', body: { checkpointId: progress.checkpointId, revision: progress.revision, operationId: 'entry-resume-restore' } });
    const me = await api('/api/me'); assert.equal(me.tutorialIntroRequired, true);
    assert.deepEqual(await prepareTutorialEntry(me, `#/doc/${docId}`, api), { route: `#/doc/${docId}` });
    assert.equal((await api(`/api/tutorial/${docId}/progress`)).i, restored.i);
    assert.deepEqual((await api('/api/tutorial')).sessions.map(s => s.docId), [docId]);
  } finally { await srv.stop(); }
});
