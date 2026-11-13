import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { coworkBuildPlugins, verifyPatches } from '../studio/build/patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = path.join(root, 'vendor/rhwp/rhwp-studio');

function load(file, patched = true) {
  const filename = path.join(studio, file);
  let source = fs.readFileSync(filename, 'utf8');
  if (patched) source = coworkBuildPlugins({ studioSrc: studio })[0].transform(source, filename)?.code ?? source;
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export /gm, '');
  const names = file.endsWith('toolbar.ts') ? 'Toolbar'
    : file.endsWith('input-handler.ts') ? 'InputHandler' : 'isPageLocalTextEditCommand';
  const context = {
    console, setTimeout, clearTimeout, t: value => value,
    ...(file.endsWith('input-handler.ts') ? load('src/engine/input-edit-invalidation.ts', false) : {}),
  };
  return vm.runInNewContext(`${compiled}\n; ({ ${names} });`, context, { filename });
}

function toolbarFixture(patched = true) {
  const { Toolbar } = load('src/ui/toolbar.ts', patched);
  const fixture = Object.create(Toolbar.prototype);
  let writes = 0;
  let scans = 0;
  const track = (value = '') => {
    let stored = value;
    const element = { style: new Proxy({}, { set(obj, key, next) { writes++; obj[key] = next; return true; } }) };
    Object.defineProperty(element, 'value', { get: () => stored, set(next) { writes++; stored = next; } });
    const classes = new Set();
    element.classList = { contains: name => classes.has(name), toggle(name, on) { writes++; if (on) classes.add(name); else classes.delete(name); } };
    return element;
  };
  for (const name of ['btnBold', 'btnItalic', 'btnUnderline', 'btnStrike', 'charfxBtn', 'fontName', 'fontSize', 'colorBar', 'colorPicker', 'highlightBar', 'lsSelect', 'styleName']) fixture[name] = track();
  const effects = ['emboss', 'engrave', 'outline', 'superscript', 'subscript'].map(name => Object.assign(track(), { dataset: { format: name } }));
  fixture.charfxMenu = { querySelectorAll: () => effects };
  fixture.alignButtons = ['Left', 'Center', 'Right', 'Justify'].map(alignment => ({ alignment, button: track() }));
  fixture.fontLang = { value: 'all' };
  fixture.styleDropdownInitialized = true;
  fixture.ensureFontOption = () => { scans++; };
  fixture.ensureLsOption = () => { scans++; };
  return { fixture, writes: () => writes, scans: () => scans };
}

const charProps = { bold: false, italic: false, underline: false, strikethrough: false, fontFamily: '한글 글꼴', fontFamilies: ['한글 글꼴', 'Latin Font'], fontSize: 1000, textColor: '#112233', shadeColor: '#ffff00' };
const paraProps = { alignment: 'Left', lineSpacingType: 'Percent', lineSpacing: 160 };

test('build patches retain unique upstream anchors', () => {
  assert.deepEqual(verifyPatches(studio).filter(report => !report.ok), []);
});

test('repeated typing preserves toolbar state without DOM rewrites or font-list scans', () => {
  for (const patched of [false, true]) {
    const f = toolbarFixture(patched);
    const update = () => {
      f.fixture.updateState({ ...charProps });
      f.fixture.updateParaState({ ...paraProps });
      f.fixture.updateStyleState({ id: 3, name: '본문' });
    };
    update();
    const baselineWrites = f.writes();
    const baselineScans = f.scans();
    for (let n = 0; n < 100; n++) update();
    if (patched) {
      assert.equal(f.writes(), baselineWrites);
      assert.equal(f.scans(), baselineScans);
    } else {
      assert.ok(f.writes() > baselineWrites + 1000, 'unpatched repeated updates reproduce DOM write amplification');
      assert.ok(f.scans() >= baselineScans + 200, 'unpatched updates repeatedly scan font and spacing options');
    }
  }
});

test('toolbar still applies changed formatting, language, and restores directly edited size', () => {
  const { fixture } = toolbarFixture();
  fixture.updateState(charProps);
  fixture.updateState({ ...charProps, bold: true, fontSize: 1400, shadeColor: '#ff0000' });
  assert.equal(fixture.btnBold.classList.contains('active'), true);
  assert.equal(fixture.fontSize.value, '14.0');
  assert.equal(fixture.highlightBar.style.background, '#ff0000');
  fixture.fontLang.value = '1';
  fixture.updateState(charProps);
  assert.equal(fixture.fontName.value, 'Latin Font');
  fixture.fontSize.value = 'invalid';
  fixture.updateState(charProps);
  assert.equal(fixture.fontSize.value, '10.0');
  fixture.updateParaState({ ...paraProps, alignment: 'Right', lineSpacing: 180 });
  assert.equal(fixture.alignButtons.find(item => item.alignment === 'Right').button.classList.contains('active'), true);
  assert.equal(fixture.lsSelect.value, '180');
  fixture.updateStyleState({ id: 7 });
  assert.equal(fixture.styleName.value, '7');
});

test('text-only mutation hint is emitted only by validated single-paragraph input paths', () => {
  const { InputHandler } = load('src/engine/input-handler.ts');
  const fixture = Object.create(InputHandler.prototype);
  fixture.deferredPaginationPending = true;
  fixture.cursor = { isInHeaderFooter: () => false, isInFootnote: () => false };
  const calls = [];
  fixture.afterEdit = () => calls.push('full');
  fixture.afterPageLocalEdit = pos => calls.push(pos ?? 'unspecified');
  const before = { sectionIndex: 0, paragraphIndex: 1, charOffset: 3 };
  const after = { ...before, charOffset: 4 };
  fixture.afterTextInputEdit(before, after, { insertedText: '가' });
  assert.equal(calls.pop(), after);
  fixture.refreshAfterOperation('auto', 'auto', 'deleteText', after, before, { deleteCount: 1 });
  assert.equal(calls.pop(), before);
  fixture.afterTextInputEdit(before, { ...after, paragraphIndex: 2 }, { insertedText: '가' });
  assert.equal(calls.pop(), 'full');
  fixture.refreshAfterOperation('auto', 'auto', 'splitParagraph', before, after);
  assert.equal(calls.pop(), 'full');
  fixture.refreshAfterOperation('pageLocal', 'auto', 'custom', before, after);
  assert.equal(calls.pop(), 'unspecified');
  fixture.afterTextInputEdit(before, after, { insertedText: '가' }, true);
  assert.equal(calls.pop(), 'full');
});

test('mutation hints snapshot nested cell paths and preserve ordinary mutation events', () => {
  const { InputHandler } = load('src/engine/input-handler.ts');
  const fixture = Object.create(InputHandler.prototype);
  const events = [];
  fixture.flushDeferredPaginationForCellOverflow = () => false;
  fixture.cursor = { getRect: () => ({ pageIndex: 0 }) };
  fixture.eventBus = { emit: (...args) => events.push(args) };
  fixture.updateCaret = () => {};
  const pos = { sectionIndex: 0, paragraphIndex: 1, charOffset: 3, parentParaIndex: 1, cellPath: [{ controlIndex: 2, cellIndex: 4, cellParaIndex: 0 }] };
  fixture.afterPageLocalEdit(pos);
  const mutation = events.find(event => event[0] === 'document-mutated');
  const pageInvalidation = events.find(event => event[0] === 'document-page-invalidated')[1];
  assert.equal(mutation[1], 'input-handler-edit');
  assert.equal(mutation[2].kind, 'text');
  assert.equal(mutation[2].position.cellPath[0].cellIndex, 4);
  pos.cellPath[0].cellIndex = 9;
  pos.charOffset = 10;
  assert.equal(mutation[2].position.cellPath[0].cellIndex, 4);
  assert.equal(mutation[2].position.charOffset, 3);
  assert.equal(pageInvalidation.textOnlyPosition.cellPath[0].cellIndex, 4);
  assert.equal(pageInvalidation.textOnlyPosition.charOffset, 3);
  events.length = 0;
  fixture.afterPageLocalEdit();
  assert.equal(events.find(event => event[0] === 'document-mutated')[2], undefined);
  assert.equal(events.find(event => event[0] === 'document-page-invalidated')[1].textOnlyPosition, undefined);
});
