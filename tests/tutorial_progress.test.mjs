import test from 'node:test';
import assert from 'node:assert/strict';
import { createTutorialProgress } from '../web/tutorial-progress.js';

test('진행 단계·문맥을 서버에 순서대로 저장하고 새 브라우저의 빈 캐시에서도 불러온다', async () => {
  const records = new Map(); const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === 'PUT') { records.set(url, options.body); return { saved: true }; }
    return structuredClone(records.get(url));
  };
  const first = createTutorialProgress({ request, token: () => 'fake-first' });
  const value = { docId: 'one', i: 4, ctx: { rid1: 1 } };
  first.save(value); value.ctx.rid1 = 2; first.save(value); first.save(value);
  first.save(null);
  first.save({ docId: 'two', i: 8, ctx: { memoId: 'm2' } });
  await Promise.all([first.flush('one'), first.flush('two')]);
  assert.deepEqual(calls.filter(c => c.url.includes('/one/')).map(c => c.body.ctx.rid1), [1, 2], '같은 값은 중복 저장하지 않고 문맥은 저장 시점의 값으로 복제한다');
  assert.equal(calls[0].headers.Authorization, 'Bearer fake-first');
  assert.equal(calls[0].keepalive, true);
  const freshBrowser = createTutorialProgress({ request });
  assert.equal(freshBrowser.state('one'), null);
  assert.deepEqual(await freshBrowser.load('one'), { docId: 'one', i: 4, ctx: { rid1: 2 } });
  assert.equal((await freshBrowser.load('two')).i, 8);
  freshBrowser.clear('two');
  assert.equal(freshBrowser.state('one').i, 4);
  assert.equal(freshBrowser.state('two'), null);
  assert.equal(records.get('/api/tutorial/two/progress').i, 8, '캐시 정리는 서버의 완료·연습 기록을 지우지 않는다');
});

test('서버 저장 실패를 알리며 토큰 변경 전에 시작한 저장은 원래 토큰으로 보낸다', async () => {
  let token = 'fake-a'; const auth = []; const errors = [];
  const progress = createTutorialProgress({ token: () => token, onError: e => errors.push(e.message), request: async (url, options) => {
    auth.push(options.headers.Authorization); throw Object.assign(new Error('저장 실패'), { status: 503 });
  } });
  progress.save({ docId: 'one', i: 1, ctx: {} }); token = 'fake-b';
  await progress.flush('one');
  assert.deepEqual(auth, ['Bearer fake-a']);
  assert.deepEqual(errors, ['저장 실패']);
});
