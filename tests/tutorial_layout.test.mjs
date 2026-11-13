import test from 'node:test';
import assert from 'node:assert/strict';
import { tutorialDock, clippedRect } from '../web/tutorial-layout.js';
import { shapeDialog, proposalControl } from '../web/tutorial-targets.js';

test('PC 안내는 중앙에 배치하고 내용 높이를 제한한다', () => {
  const view = { x: 0, y: 0, w: 1440, h: 900 }; const editor = { x: 0, y: 50, w: 1100, h: 850 };
  assert.deepEqual(tutorialDock(view, editor), { x: 500, y: 320, w: 440, h: 260, max: 260 });
  assert.deepEqual(tutorialDock(view, { ...editor, w: 800 }), tutorialDock(view, editor));
  assert.deepEqual(tutorialDock(view, editor, false, { height: 120 }), { x: 500, y: 390, w: 440, h: 120, max: 260 });
  assert.equal(tutorialDock(view, editor, false, { height: 900 }).h, 260, '긴 안내는 최대 높이 안에서 스크롤한다');
  assert.equal(tutorialDock(view, editor, false, { height: 120, avoid: { x: 600, y: 700, w: 100, h: 40 } }).y, 756);
});

test('PC는 화면 모서리의 대상과 열린 입력창을 가리지 않고 근처에 배치한다', () => {
  const view = { x: 0, y: 0, w: 1440, h: 900 };
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const target of [
    { x: 600, y: 400, w: 80, h: 32 },
    { x: 10, y: 10, w: 80, h: 32 },
    { x: 1350, y: 850, w: 80, h: 32 },
    { x: 1350, y: 10, w: 80, h: 32 },
    { x: 10, y: 850, w: 80, h: 32 },
  ]) {
    const dock = tutorialDock(view, null, false, { height: 120, target, avoid: target });
    assert.ok(!overlaps(dock, target));
    assert.ok(dock.x >= 12 && dock.x + dock.w <= 1428 && dock.y >= 12 && dock.y + dock.h <= 888);
    assert.ok(Math.hypot(Math.max(dock.x - target.x - target.w, 0, target.x - dock.x - dock.w), Math.max(dock.y - target.y - target.h, 0, target.y - dock.y - dock.h)) <= 16);
  }
  const dialog = { x: 440, y: 250, w: 560, h: 400 };
  const dock = tutorialDock(view, null, false, { height: 120, target: { x: 880, y: 580, w: 80, h: 32 }, avoid: dialog });
  assert.ok(!overlaps(dock, dialog));
  const offset = tutorialDock({ x: 30, y: 100, w: 1100, h: 600 }, null, true, { center: true, height: 300 });
  assert.deepEqual([offset.x, offset.y], [260, 250]);
});

test('모바일은 편집기 아래에 배치하되 입력창을 피하고 소개는 중앙에 둔다', () => {
  // 휴대폰: 편집기 아래쪽에 열린 AI 요청 입력 칸을 가리면 편집기 위쪽으로 옮긴다
  const phone = { x: 0, y: 0, w: 390, h: 844 }; const phoneEditor = { x: 0, y: 65, w: 390, h: 475 };
  const moved = tutorialDock(phone, phoneEditor, false, { height: 150, avoid: { x: 19, y: 376, w: 352, h: 85 } });
  assert.deepEqual([moved.y, moved.h], [77, 150]);
  assert.ok(moved.y + moved.h <= 376);
  for (const h of [844, 360]) {
    const dock = tutorialDock({ x: 0, y: 0, w: 390, h }, { x: 0 });
    assert.ok(dock.x >= 0 && dock.x + dock.w <= 390 && dock.y >= 0 && dock.y + dock.h <= h);
  }
  const intro = tutorialDock(phone, phoneEditor, false, { height: 150, center: true });
  assert.deepEqual([intro.x, intro.y], [12, 347]);
  assert.equal(clippedRect({ x: 1600, y: 40, w: 100, h: 40 }, phone), null);
  const stacked = tutorialDock({ x:0,y:0,w:900,h:524 }, { x:0,y:50,w:900,h:315 });
  assert.ok(stacked.y+stacked.h<=353,'아래에 열린 AI 패널을 안내창으로 가리지 않는다');
});

test('글자·문단 모양 창은 종류와 실제 열림을 구분한다', () => {
  const character = { getBoundingClientRect: () => ({ width: 600, height: 500 }) };
  const hiddenParagraph = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const doc = { querySelectorAll: selector => selector === '.dialog-wrap.cs-dialog' ? [character] : selector === '.dialog-wrap.ps-dialog' ? [hiddenParagraph] : (() => { throw new Error('다른 창을 대신 찾으면 안 된다'); })() };
  assert.equal(shapeDialog(doc, 'char'), character); assert.equal(shapeDialog(doc, 'para'), null);
});

test('제안 단추는 요청·제안 번호와 반영·거절 종류가 일치한 것만 찾는다', () => {
  const target = { getBoundingClientRect: () => ({ width: 60, height: 28 }) };
  const selectors = [];
  const doc = { querySelectorAll: selector => { selectors.push(selector); return selector.includes('data-rid="7"') && selector.includes('data-pid="12"') && selector.includes('button.rs-reject:') ? [target] : []; } };
  assert.equal(proposalControl(doc, 12, 'reject', 7), target);
  assert.equal(proposalControl(doc, 11, 'apply', 7), null);
  assert.ok(selectors.every(s => s.includes('data-rid="7"') && s.includes('data-pid=')));
});
