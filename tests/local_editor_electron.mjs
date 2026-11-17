// Run with Electron, not node --test. Isolated production main/preload/renderer;
// native file selections/confirmation responses are mocked, input uses Chromium.
// This exercises browser input/IME/focus/close, not layout screenshots (AGENTS §2.1).
import { app, dialog, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const at = process.argv.indexOf(name); if (at < 0 || !process.argv[at + 1]) throw Error('Required: ' + name); return path.resolve(process.argv[at + 1]); };
const assets = argument('--assets'), output = argument('--out');
if (!output.startsWith(path.join(root, 'artifacts') + path.sep)) throw Error('Test output must be under artifacts');
fs.mkdirSync(output, { recursive: true });
const work = fs.mkdtempSync(path.join(output, 'electron-test-'));
const original = path.join(work, 'original.hwpx'), copy = path.join(work, 'copy.hwpx');
const fixture = process.argv.includes('--fixture') ? argument('--fixture') : path.join(root, 'tests/fixtures/hangul_trk_brk_base.hwpx');
if (!fixture.startsWith(path.join(root, 'tests') + path.sep)) throw Error('Use a repository test fixture, not user data');
fs.copyFileSync(fixture, original);
process.env.HWPX_LOCAL_ASSETS = assets;
process.env.HWPX_LOCAL_PROFILE = path.join(work, 'profile');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let initialized = 0, cancelSave = false, discard = false, closePrompts = 0, finish = null;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [original] });
dialog.showSaveDialog = async () => ({ canceled: cancelSave, filePath: copy });
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  console.log('NATIVE_DIALOG', options.message, options.buttons);
  if (options.buttons?.includes('저장하지 않고 종료')) {
    closePrompts++;
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    return { response: discard ? 1 : 0 };
  }
  throw Error('Unexpected native dialog: ' + options.message);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summarize = values => { const sorted = [...values].sort((a,b) => a-b); return { count: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor((sorted.length - 1) * .95)], maxMs: Math.max(...values) }; };
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false); win.hide();
  win.webContents.on('console-message', (_e, ...args) => {
    if (args.some(a => typeof a === 'string' && a.includes('[initDoc] 9.'))) initialized++;
    if (args.some(a => typeof a === 'string' && /error|실패|initDoc|document load/i.test(a))) console.log('RENDERER', ...args);
  });
  win.webContents.once('did-finish-load', () => void exercise(win));
  win.once('closed', () => { if (finish) finish(); });
});

async function exercise(win) {
  const js = code => win.webContents.executeJavaScript(code, true);
  const requestClose = () => process.argv.includes('--quit') ? app.quit() : win.close();
  const wait = async (code, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (!await js(code)) { if (Date.now() > deadline) throw Error('Timeout: ' + code); await pause(50); }
  };
  try {
    await wait('!!window.rhwpStudio?.automation');
    const deadline = Date.now() + 60000;
    while (!initialized) { if (Date.now() > deadline) throw Error('initial document timeout'); await pause(100); }
    await js(`window.rhwpStudio.automation.registerCommand({id:'ext:local-input-test',label:'test',execute(s){window.__localTest=s}});window.rhwpStudio.automation.execute('ext:local-input-test',{});'ready'`);
    const beforeOpen = initialized;
    await js(`window.rhwpStudio.automation.execute('file:open',{}, {allowDialog:true})`);
    await wait(`window.__localTest.wasm.fileName==='original.hwpx' && !window.__localTest.documentState.isDirty() && !document.querySelector('.modal-overlay')`);
    while (initialized <= beforeOpen) { if (Date.now() > deadline) throw Error('opened document timeout'); await pause(50); }
    await pause(250);
    await wait(`!!window.__localTest.getInputHandler()`);
    const target = await js(`(()=>{
      const s=window.__localTest;
      for(let para=0;para<s.wasm.getParagraphCount(0);para++){
        const length=s.wasm.getParagraphLength(0,para);
        if(length<3)continue;
        const text=s.wasm.getTextRange(0,para,0,length);
        if(s.getInputHandler().moveCursorTo({sectionIndex:0,paragraphIndex:para,charOffset:1})) {
          s.getInputHandler().focus();return {para,text};
        }
      }
      throw Error('No body input position');
    })()`);
    await js(`window.__inputStats={full:0,paragraph:0,events:[],errors:[]};
      const d=window.__localTest.wasm.doc;
      for(const [name,key] of [['collectCanvasMetricRequests','full'],['collectCanvasMetricRequestsForParagraph','paragraph']]){
        const original=d[name]; if(typeof original==='function')d[name]=function(...args){window.__inputStats[key]++;return original.apply(this,args)};
      }
      for(const type of ['input','compositionstart','compositionend'])document.addEventListener(type,e=>{
        const entry={type,inputType:e.inputType,composing:e.isComposing,data:e.data};window.__inputStats.events.push(entry);
        queueMicrotask(()=>{const s=window.__localTest;entry.cursor=s.getInputHandler().getCursorPosition();entry.length=s.wasm.getParagraphLength(0,${target.para})});
      },true);
      window.addEventListener('error',e=>window.__inputStats.errors.push(e.message));
      window.addEventListener('unhandledrejection',e=>window.__inputStats.errors.push(String(e.reason)));
      'observing'`);
    win.webContents.debugger.attach('1.3');
    const cdp = (name, params) => win.webContents.debugger.sendCommand(name, params);
    const ordinary = '가나다ABC '.repeat(12);
    const inputMs = [];
    for (const char of ordinary) { const start = performance.now(); await cdp('Input.insertText', { text: char }); inputMs.push(performance.now() - start); }
    const compositionMs = [];
    let composed = '';
    for (let repeat = 0; repeat < 8; repeat++) for (const parts of [['ㅎ','하','한'],['ㄱ','그','글'],['ㄱ','가','값']]) {
      for (const text of parts) {
        const start = performance.now();
        await cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        compositionMs.push(performance.now() - start);
      }
      const text = parts.at(-1); composed += text;
      await cdp('Input.insertText', { text });
    }
    const expected = target.text.slice(0,1) + ordinary + composed + target.text.slice(1);
    const read = `window.__localTest.wasm.getTextRange(0,${target.para},0,window.__localTest.wasm.getParagraphLength(0,${target.para}))`;
    assert.equal(await js(read), expected, 'continuous typing and composed syllables must be inserted exactly once');
    await pause(400);
    const stats = await js('window.__inputStats');
    assert.deepEqual(stats.errors, []);
    assert.equal(stats.events.filter(e => e.type === 'compositionstart').length, 24);
    assert.equal(stats.events.filter(e => e.type === 'compositionend').length, 24);
    const report = {
      pass: true, environment: 'Windows Electron ' + process.versions.electron,
      inputMethod: 'Chromium Input.insertText + Input.imeSetComposition; not macOS OS IME',
      productionMain: true, productionPreload: true, productionRenderer: true,
      nativeDialogs: 'mocked file choices/confirmation responses', hiddenWindow: true,
      build: JSON.parse(fs.readFileSync(path.join(assets,'local-build.json'))),
      fixture: path.relative(root, fixture), pages: await js('window.__localTest.wasm.pageCount'),
      continuousCharacters: ordinary.length, committedKoreanSyllables: composed.length,
      inputTiming: summarize(inputMs), compositionTiming: summarize(compositionMs), metrics: { full: stats.full, paragraph: stats.paragraph },
      textPreserved: true, eventCounts: Object.fromEntries(['input','compositionstart','compositionend'].map(type => [type,stats.events.filter(e => e.type === type).length])),
      checks: ['continuous input', '24 Korean compositions committed once'], work, realMacTested: false,
      closeEntry: process.argv.includes('--quit') ? 'app.quit (Quit menu)' : 'window.close (window button)',
    };
    if (process.argv.includes('--typing-only')) {
      fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report,null,2)); console.log('PASS',work,JSON.stringify(report.metrics)); app.exit(0); return;
    }
    await js(`window.rhwpStudio.automation.execute('file:save',{}, {allowDialog:true})`);
    await wait(`!window.__localTest.documentState.isDirty()`);
    // 앱 메뉴 파일 → 저장(2026-11-16): 메뉴는 단축키를 등록하지 않고(편집기가 직접 받음) 같은 저장 명령을 부른다
    const fileMenu = ['file:new-doc', 'file:open', 'file:save', 'file:save-as', 'file:print'].map(id => Menu.getApplicationMenu().getMenuItemById(id));
    assert.ok(fileMenu.every(Boolean), 'file menu commands exist');
    assert.ok(fileMenu.filter(item => item.accelerator).every(item => item.registerAccelerator === false), 'file menu shortcuts are display-only');
    await js(`window.__localTest.getInputHandler().focus()`);
    await cdp('Input.insertText', { text: 'MENUSAVE' });
    await wait(`window.__localTest.documentState.isDirty()`);
    Menu.getApplicationMenu().getMenuItemById('file:save').click();
    await wait(`!window.__localTest.documentState.isDirty()`);
    const saved = fs.readFileSync(original);
    assert.notEqual(hash(saved), hash(fs.readFileSync(fixture)));
    const archive = await JSZip.loadAsync(saved);
    const xml = await archive.file('Contents/section0.xml').async('string');
    assert.ok(xml.includes(composed), 'saved XML contains all composed syllables');
    assert.ok(xml.includes('MENUSAVE'), 'app menu save wrote the open file');
    await js(`window.rhwpStudio.automation.execute('file:save-as-hwpx',{}, {allowDialog:true})`);
    await wait(`!!document.querySelector('.modal-overlay .dialog-btn-primary')`);
    await js(`document.querySelector('.modal-overlay .dialog-btn-primary').click()`);
    await wait(`window.__localTest.wasm.fileName==='copy.hwpx' && !window.__localTest.documentState.isDirty()`);
    assert.equal(hash(fs.readFileSync(original)), hash(saved));
    const savedCopy = hash(fs.readFileSync(copy));
    await js(`window.__localTest.getInputHandler().focus()`);
    await cdp('Input.insertText', { text: 'UNSAVED_EXIT' });
    await wait(`window.__localTest.documentState.isDirty()`);
    const unsavedText = await js(read);
    assert.ok(unsavedText.includes('UNSAVED_EXIT'));
    cancelSave = true;
    await js(`window.rhwpStudio.automation.execute('file:save-as-hwpx',{}, {allowDialog:true})`);
    await wait(`!!document.querySelector('.modal-overlay .dialog-btn-primary')`);
    await js(`document.querySelector('.modal-overlay .dialog-btn-primary').click()`);
    await pause(200);
    assert.equal(await js('window.__localTest.documentState.isDirty()'), true);
    requestClose();
    await pause(200);
    assert.equal(closePrompts, 1);
    assert.equal(win.isDestroyed(), false);
    assert.equal(await js(read), unsavedText);
    assert.equal(hash(fs.readFileSync(copy)), savedCopy);
    report.checks.push('save original', 'app menu save', 'save-as preserves original', 'save-as cancellation keeps dirty state', 'cancel close keeps editing');
    finish = () => {
      assert.equal(closePrompts, 2);
      assert.equal(hash(fs.readFileSync(copy)), savedCopy);
      assert.equal(hash(fs.readFileSync(original)), hash(saved));
      report.checks.push('discard closes dirty app without saving');
      fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report,null,2));
      console.log('PASS', work, JSON.stringify(report.metrics)); app.exit(0);
    };
    discard = true; requestClose();
  } catch (error) {
    const state = await js(`({stats:window.__inputStats,cursor:window.__localTest?.getInputHandler()?.getCursorPosition(),activeElement:document.activeElement?.outerHTML})`).catch(() => null);
    fs.writeFileSync(path.join(work,'failure.json'), JSON.stringify({error:error.stack,work,state},null,2));
    console.error(error); app.exit(1);
  }
}
setTimeout(() => { console.error('GLOBAL TIMEOUT',work); app.exit(2); }, 180000).unref();
await import(pathToFileURL(path.join(root,'deploy/local-editor/main.mjs')).href);
