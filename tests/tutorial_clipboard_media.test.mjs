import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClipboard } from '../web/tutorial-modules/clipboard.js';
import { buildComposedTutorialSteps, describeTutorialModule } from '../web/tutorial-modules/compose.js';
import { tutorialScene, TUTORIAL_SCENES } from '../web/tutorial-scenes.js';
import { TUTORIAL_MODULES } from '../web/tutorial-definition.js';

const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, clipboard: {}, config: {},
  focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {}, locate() {}, phraseRect() {}, cw() {} });

function documentStub() {
  const doc = { createElement(tag) {
    return { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], attrs: {}, listeners: {}, className: '', hidden: false,
      append(...items) { this.children.push(...items); }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; } };
  } }; return doc;
}

test('예전 빈칸 검사·영상 참조(1s3lf9h)는 한/글 붙여넣기 그림 장면으로 이어지고 붙여넣기 이벤트를 요구하지 않는다', () => {
  const steps = buildClipboard(environment());
  const scene = steps.find(step => step.scene === 'hangul-paste');
  assert.ok(scene); assert.equal(scene.stepId, '1s3lf9h'); assert.equal(scene.until, undefined); assert.equal(scene.enter, undefined);
  assert.equal(scene.media, undefined, '촬영 영상을 더 쓰지 않는다');
  assert.ok(scene.next); assert.ok(!steps.some(step => /글 확인용|이 칸을 누르고|영상/.test(String(step.text))));
  assert.equal(describeTutorialModule('clipboard-transfer').steps.find(step => step.stepId === '1s3lf9h').title, scene.title);
  assert.equal(describeTutorialModule('clipboard-transfer').steps.find(step => step.stepId === '1s3lf9h').actionKind, 'scene');
  const composed = buildComposedTutorialSteps({ sourceId: 'clipboard', modules: [{ key: 'clip', moduleId: 'clipboard-transfer', steps: [{ key: 'old-paste', kind: 'builtin', stepId: '1s3lf9h' }] }] }, environment());
  const version = TUTORIAL_MODULES.find(module => module.id === 'clipboard-transfer').version;
  assert.equal(composed[1].scene, 'hangul-paste'); assert.equal(composed[1].id, `clip/${version}/1s3lf9h`);
});

test('그림 장면은 영상 파일 없이 단계별로 재생하고, 동작 줄이기면 마지막 장면을 정지 그림으로 두며 정리한다', async () => {
  for (const name of Object.keys(TUTORIAL_SCENES)) {
    const spec = TUTORIAL_SCENES[name];
    assert.ok(!/<video|\.mp4|<img|https?:/.test(spec.html), `${name}: 영상·바깥 그림을 불러오지 않는다`);
    assert.ok(spec.beats.length >= 3 && spec.beats.every((t, i) => i === 0 || t > spec.beats[i - 1]), `${name}: 단계 시각이 차례로 늘어난다`);
    assert.ok(spec.title && spec.steps.length >= 2);
    const doc = documentStub(); const root = doc.createElement('div');
    const cleanup = tutorialScene(root, name, { reduced: () => true });
    const figure = root.children[0]; const stage = figure.children[0]; const replay = figure.children.at(-1);
    assert.equal(figure.attrs['data-scene'], name); assert.equal(stage.attrs.role, 'img'); assert.ok(stage.attrs['aria-label']);
    assert.equal(stage.attrs['data-beat'], String(spec.beats.length), '정지 그림은 마지막 장면'); assert.equal(replay.hidden, true);
    assert.ok(!figure.children.some(node => ['VIDEO', 'INPUT', 'TEXTAREA'].includes(node.tagName)));
    cleanup(); assert.equal(replay.listeners.click, undefined);
  }
  const doc = documentStub(); const root = doc.createElement('div');
  const cleanup = tutorialScene(root, 'hangul-paste', { reduced: () => false });
  const stage = root.children[0].children[0]; const replay = root.children[0].children.at(-1);
  assert.equal(stage.attrs['data-beat'], '0'); assert.equal(replay.hidden, false);
  await new Promise(resolve => setTimeout(resolve, TUTORIAL_SCENES['hangul-paste'].beats[0] + 80));
  assert.equal(stage.attrs['data-beat'], '1'); assert.match(stage.className, /(^| )ts-b1( |$)/);
  cleanup();
  await new Promise(resolve => setTimeout(resolve, TUTORIAL_SCENES['hangul-paste'].beats[1] + 80));
  assert.equal(stage.attrs['data-beat'], '1', '정리한 뒤에는 다음 단계로 넘어가지 않는다');
  assert.throws(() => tutorialScene(root, 'no-such-scene'), /등록되지 않은/);
});

test('조판 부호는 충분히 살펴본 후 넘기며 도구 막대와 다음 단계 유무에 관계없이 원복한다', () => {
  for (const initial of [false, true]) {
    const env = environment(); let shown = initial;
    env.fdoc = () => ({ querySelectorAll: () => [], defaultView: { rhwpStudio: { automation: { getContext: () => ({ showControlCodes: shown }), execute: command => { assert.equal(command, 'view:ctrl-mark'); shown = !shown; } } } } });
    const step = buildClipboard(env).find(step => step.title === '조판 부호 켜기');
    const cleanup = step.enter(); step.action.run(); assert.equal(shown, !initial);
    assert.ok(step.next); assert.equal(step.until, undefined); assert.equal(step.click, undefined);
    cleanup(); assert.equal(shown, initial);
  }
});
