import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTutorialInput } from '../web/tutorial-interaction.js';

test('문서와 iframe의 버튼·입력·붙여넣기·키보드를 안내가 차단하지 않는다', () => {
  for (const context of ['document', 'iframe']) {
    const doc = new EventTarget(); const seen = [];
    const off = observeTutorialInput(doc, { onClick: e => seen.push(e.type), onClipboard: e => seen.push(e.type) });
    for (const type of ['pointerdown', 'click', 'beforeinput', 'input', 'paste', 'keydown', 'copy', 'cut']) {
      let received = false; doc.addEventListener(type, () => { received = true; }, { once: true });
      const event = new Event(type, { cancelable: true });
      assert.equal(doc.dispatchEvent(event), true, context + '/' + type);
      assert.equal(event.defaultPrevented, false); assert.equal(received, true);
    }
    assert.deepEqual(seen, ['click', 'copy', 'cut']); off();
  }
});

test('앱이 처리한 복사는 관찰하면서도 처리 상태를 바꾸지 않는다', () => {
  const doc = new EventTarget(); let observed;
  doc.addEventListener('copy', e => e.preventDefault());
  const off = observeTutorialInput(doc, { onClick() {}, onClipboard: e => { observed = e.defaultPrevented; } });
  const event = new Event('copy', { cancelable: true }); doc.dispatchEvent(event);
  assert.equal(observed, true); assert.equal(event.defaultPrevented, true); off();
});

test('단계를 떠나거나 iframe이 바뀌면 옛 관찰자를 제거한다', () => {
  // DOM EventTarget의 capture 옵션까지 같은 방식으로 해제되는지 확인합니다.
  const listeners = new Map();
  const doc = { addEventListener(type, fn, capture) { listeners.set(type, [fn, capture]); },
    removeEventListener(type, fn, capture) { assert.deepEqual(listeners.get(type), [fn, capture]); listeners.delete(type); } };
  const off = observeTutorialInput(doc, { onClick() {}, onClipboard() {} });
  assert.equal(listeners.size, 3); off(); assert.equal(listeners.size, 0);
});
