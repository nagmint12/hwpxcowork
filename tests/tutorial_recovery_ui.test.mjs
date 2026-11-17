import test from 'node:test';
import assert from 'node:assert/strict';
import { createTutorialTimeline, tutorialViewSnapshot, tutorialStoredView, restoreTutorialView } from '../web/tutorial-recovery.js';
import { createTutorialProgress } from '../web/tutorial-progress.js';

test('같은 단계에 다시 들어와도 이전 실행의 callback은 무효이고 중단 뒤 재사용되지 않는다', () => {
  const timeline = createTutorialTimeline();
  const first = timeline.ticket();
  assert.equal(timeline.current(first), true);
  timeline.renew();
  assert.equal(timeline.current(first), false);
  const second = timeline.ticket();
  assert.equal(timeline.current(second), true);
  timeline.stop();
  assert.equal(timeline.current(second), false);
  assert.equal(timeline.current(timeline.ticket()), false);
});

test('현재 단계로 복귀하면 다른 창을 닫고 필요한 창과 대상·입력을 독립 복사본으로 복구한다', () => {
  const state = { tab: 'review', active: { kind: 'memo', id: 'm1' }, activeRid: 7,
    composer: null, popover: { kind: 'memo', target: { ref: 's0/p3' }, text: '처음 글' }, reply: null };
  const snapshot = tutorialViewSnapshot(state);
  state.popover.text = '잘못 바꾼 글'; state.composer = { kind: 'instruct' }; state.tab = 'ai';
  const closed = [];
  restoreTutorialView(snapshot, state, kind => { closed.push(kind); state[kind] = null; });
  assert.deepEqual(closed, ['composer', 'popover', 'reply']);
  assert.equal(state.composer, null); assert.equal(state.popover.text, '처음 글');
  assert.equal(state.popover.target.ref, 's0/p3'); assert.equal(state.tab, 'review');
  state.popover.text = '복귀 후 글';
  assert.equal(snapshot.windows.popover.text, '처음 글');
});

test('순차 진행 저장은 서버 revision을 다음 요청에 사용하며 입력 중인 ctx를 응답으로 덮지 않는다', async () => {
  const calls = []; let revision = 3;
  const progress = createTutorialProgress({ request: async (url, options) => {
    if (!options) return { docId: 'one', i: 2, ctx: {}, revision, checkpointId: 'cp2' };
    calls.push(options.body);
    assert.equal(options.body.revision, revision);
    return { ...options.body, ctx: { obsolete: true }, revision: ++revision, checkpointId: `cp${options.body.i}`, checkpoints: [] };
  } });
  const value = await progress.load('one');
  value.ctx.input = 'a'; progress.save(value);
  value.i = 3; value.ctx.input = 'b'; progress.save(value);
  await progress.flush('one', { strict: true });
  assert.deepEqual(calls.map(c => c.revision), [3, 4]);
  assert.equal(value.ctx.input, 'b'); assert.equal(value.ctx.obsolete, undefined);
  assert.equal(value.revision, 5); assert.equal(value.checkpointId, 'cp3');
});

test('복구 응답 채택 후 이전 대기 저장은 취소되고 checkpoint와 복구된 진행을 유지한다', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  const progress = createTutorialProgress({ request: async (url, options) => { calls.push(options.body); await gate; return { revision: 1, checkpointId: 'old' }; } });
  progress.save({ docId: 'one', i: 4, ctx: {} });
  await Promise.resolve();
  progress.save({ docId: 'one', i: 5, ctx: {} });
  progress.adopt({ docId: 'one', i: 3, ctx: { restored: true }, revision: 8, checkpointId: 'safe' });
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(progress.state('one').i, 3); assert.equal(progress.state('one').revision, 8);
  assert.equal(progress.state('one').checkpointId, 'safe');
});

test('checkpoint를 준비하지 못하면 strict flush는 실패를 전달하고 명시적인 재시도만 전송한다', async () => {
  let fail = true; let calls = 0;
  const progress = createTutorialProgress({ request: async () => { calls++; if (fail) throw Object.assign(new Error('연결 끊김'), { status: 503 }); return { revision: 1 }; } });
  const value = { docId: 'one', i: 2, ctx: {} }; progress.save(value);
  await assert.rejects(progress.flush('one', { strict: true }), /연결 끊김/);
  assert.equal(calls, 1); fail = false; progress.save(value); await progress.flush('one', { strict: true });
  assert.equal(calls, 2);
});

test('복구 전 실행의 늦은 저장 실패도 새 실행의 실패 상태와 안내를 오염시키지 않는다', async () => {
  let reject; const gate = new Promise((resolve, fail) => { reject = fail; }); const errors = [];
  const progress = createTutorialProgress({ request: () => gate, onError: e => errors.push(e.message) });
  progress.save({ docId: 'one', i: 7, ctx: {} }); await Promise.resolve();
  progress.adopt({ docId: 'one', i: 2, ctx: {}, revision: 8, checkpointId: 'safe' });
  reject(Object.assign(new Error('옛 저장 실패'), { status: 409 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  await progress.flush('one', { strict: true });
  assert.deepEqual(errors, []); assert.equal(progress.state('one').revision, 8);
});

test('다시 열 창에는 전체store/토큰을 저장하지 않고 자동전송·미완료첨부·타이핑을 재실행하지 않는다', () => {
  const state = { token: 'secret', paragraphs: [{ text: '전체 문서' }], composer: { key: 1, autoSend: true, tutorialTyping: true,
    instruction: '예시', pending: [{ bytes: '대용량' }], target: { text: '범위', ref: 's0/p1' } } };
  const stored = tutorialStoredView(state);
  assert.equal(stored.token, undefined); assert.equal(stored.paragraphs, undefined);
  assert.equal(stored.windows.composer.autoSend, false); assert.equal(stored.windows.composer.tutorialTyping, false);
  assert.deepEqual(stored.windows.composer.pending, []);
  const restored = {}; restoreTutorialView(tutorialViewSnapshot(state), restored, () => {});
  assert.equal(restored.composer.autoSend, false);
  state.composer.attachments = [{ unexpected: 'x'.repeat(15000) }];
  assert.equal(tutorialStoredView(state), null, '진행 저장 32KB를 넘길 창 정보는 저장하지 않는다');
});

test('전송 중 재접속한 요청 창은 새 실행의 입력 상태로 돌아온다', () => {
  const state = { composer: { key: 1, phase: 'sending', instruction: '확인 요청' } };
  const saved = tutorialStoredView(state);
  assert.equal(saved.windows.composer.phase, 'edit');
  assert.equal(state.composer.phase, 'sending');
  const restored = {};
  restoreTutorialView(tutorialViewSnapshot(state), restored, () => {});
  assert.equal(restored.composer.phase, 'edit');
  assert.equal(restored.composer.instruction, '확인 요청');
});
