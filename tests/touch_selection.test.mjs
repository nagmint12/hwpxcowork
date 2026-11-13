import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoldDrag } from '../studio/plugin/touch-selection.ts';

const setup = () => {
  const events = []; let timer; let id = 0;
  const hold = createHoldDrag({ start: p => events.push(['down',p]), move: p => events.push(['move',p]), end: p => events.push(['up',p]), schedule(fn, ms) { assert.equal(ms,400); timer=fn; return ++id; }, clear() { timer=null; } });
  return { hold, events, tick() { const fn=timer; timer=null; fn?.(); } };
};
test('짧은 탭과 누른 직후의 스크롤은 선택 드래그를 시작하지 않는다', () => {
  const a=setup(); a.hold.start({x:10,y:20}); a.hold.end(); a.tick(); assert.deepEqual(a.events,[]);
  const b=setup(); b.hold.start({x:10,y:20}); b.hold.move({x:10,y:45}); b.tick(); assert.deepEqual(b.events,[]); assert.equal(b.hold.selecting,false);
});
test('400ms 유지 후 움직임은 마우스 드래그와 같은 down·move·up 순서가 된다', () => {
  const a=setup(); a.hold.start({x:10,y:20}); a.tick(); assert.equal(a.hold.selecting,true);
  a.hold.move({x:130,y:50}); a.hold.end(); assert.deepEqual(a.events,[['down',{x:10,y:20}],['move',{x:130,y:50}],['up',{x:130,y:50}]]); assert.equal(a.hold.selecting,false);
});
test('선택 중 취소는 드래그를 끝내고 지연된 동작을 남기지 않는다', () => {
  const a=setup(); a.hold.start({x:10,y:20}); a.tick(); a.hold.cancel(); a.tick();
  assert.deepEqual(a.events.map(e=>e[0]),['down','up']); assert.equal(a.hold.selecting,false);
});
