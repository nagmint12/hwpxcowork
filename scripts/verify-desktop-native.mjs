#!/usr/bin/env node
// Native app smoke test. Runs only a new profile and a COPY of the fixture.
// CDP composition is not a test of the operating system's Korean IME.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const app = path.resolve(option('--app', ''));
const out = path.resolve(option('--out', ''));
assert(option('--app') && option('--out'), 'Use --app <native executable> --out <new directory> [--fixture <hwpx>]');
assert(!fs.existsSync(out), 'Evidence output must be a NEW directory');
assert(fs.statSync(app).isFile(), 'Native executable missing');
const appDir = option('--app-dir'); // Development Electron only; never counts as a packaged Mac run.
const payload = path.resolve(option('--payload', path.resolve(path.dirname(app), '../Resources/payload/app')));
const fixture = path.resolve(option('--fixture', path.join(root, 'tests/fixtures/hangul_trk_brk_base.hwpx')));
const archive = option('--archive');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const fixtureSha256 = fileSha(fixture);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const poll = async (fn, label, timeout = 60000) => {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await pause(120); }
  throw Error('Timed out: ' + label + (last ? ': ' + last.message : ''));
};
fs.mkdirSync(out, { recursive: true });
const profile = path.join(out, 'profile'); // The app itself creates this, refusing existing profiles.
const docs = path.join(out, 'documents'); fs.mkdirSync(docs);
const copied = path.join(docs, 'native-smoke.hwpx'); fs.copyFileSync(fixture, copied);
const result = { schema: 1, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  osRelease: os.release(), packagedApp: !appDir, app, executableSha256: fileSha(app),
  archiveSha256: archive ? fileSha(path.resolve(archive)) : null,
  wasmSha256: fileSha(path.join(payload, 'studio/dist/rhwp_bg.wasm')),
  checks: [], nativeKoreanIme: 'unverified', finderLaunch: 'unverified', longSession: 'unverified', pass: false };
if (process.platform === 'darwin') {
  result.macos = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim();
  const bundle = path.resolve(path.dirname(app), '../..');
  result.codesign = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' }).status === 0;
  result.gatekeeper = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle], { encoding: 'utf8' }).status === 0;
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HWPX_|ANTHROPIC_|OPENAI_|GEMINI_API_KEY|GOOGLE_API_KEY|BAZE_API_KEY|ELECTRON_|NODE_OPTIONS|NODE_PATH)/i.test(key)));
if (appDir) Object.assign(env, { HWPX_DESKTOP_PAYLOAD: payload, HWPX_DESKTOP_NODE: process.execPath });
// 사용자가 여는 것처럼 창을 보이게 띄운다(2026-11-18). windowsHide:true 는 Windows 에서 첫 창을 SW_HIDE 로 띄워(STARTUPINFO)
// 문서가 visibilityState 'hidden' 이 되고, 데스크톱 편집기는 설치 글꼴을 읽기 전에 창이 보이기를 기다리므로(studio/build/font-selection-patches.mjs
// desktop-local-font-automatic-preparation) '문서 초기화 중'에 멈추거나 글꼴 단계가 'Page needs to be visible' 로 실패했다(약 3번에 1번).
// 시험이 다른 창 뒤에서 돌 때 Chromium 이 가려진 창을 hidden 으로 바꾸지 않게 가림 계산도 끈다(시험 환경만 — 앱 동작은 그대로).
const child = spawn(app, [...(appDir ? [path.resolve(appDir)] : []), '--verification-profile', profile, '--disable-features=CalculateNativeWinOcclusion'], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
// Do not persist stdout: the personal server's bootstrap URL includes a private token.
child.stdout.resume(); child.stderr.resume();
let exited = false, exitCode; child.once('exit', code => { exited = true; exitCode = code; });
let ws, browserWs, origin, api, nextId = 0;
const requests = new Map();
const connect = url => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => resolve(socket), { once: true });
  socket.addEventListener('error', () => reject(Error('CDP connection failed')), { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { requests.delete(id); reject(Error('CDP timeout: ' + method)); }, 45000);
  requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const frame = code => js(`(async()=>{const w=document.querySelector('.editorhost iframe').contentWindow;const d=w.document;${code}})()`);
const pass = (name, details = {}) => { result.checks.push({ name, status: 'pass', ...details }); console.log('PASS ' + name); };
let blockedExternal = 0;
try {
  const port = await poll(() => {
    assert(!exited, 'App exited before CDP ready: ' + exitCode);
    return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  }, 'native app startup');
  const targets = await poll(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find(t => t.type === 'page' && /^http:\/\/localhost:\d+\//.test(t.url));
  }, 'personal library');
  origin = new URL(targets.url).origin;
  const cfg = JSON.parse(fs.readFileSync(path.join(profile, 'personal/config.json'), 'utf8'));
  assert.equal(cfg.host, '127.0.0.1'); assert.equal(String(cfg.port), new URL(origin).port); assert.notEqual(cfg.port, 8787);
  const token = cfg.users.find(u => u.role === 'admin').token;
  api = async (endpoint, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(origin + endpoint, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Error('Private test API ' + endpoint + ': ' + r.status);
    return r.json();
  };
  ws = await connect(targets.webSocketDebuggerUrl);
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && requests.has(m.id)) { const p = requests.get(m.id); requests.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') {
      const u = new URL(m.params.request.url);
      const local = ['localhost', '127.0.0.1'].includes(u.hostname) && u.port === new URL(origin).port;
      if (!local) blockedExternal++;
      void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: m.params.requestId, ...(!local ? { errorReason: 'InternetDisconnected' } : {}) }).catch(() => {});
    }
  });
  await send('Runtime.enable');
  // From this point external HTTP(S) resources fail. The app's own loopback API stays available.
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }, { urlPattern: 'https://*', requestStage: 'Request' }] });
  await poll(() => js("document.title.includes('Hwpx') || document.title.includes('HWPX')"), 'cowork branding');
  // Wait for the real #/t/<token> bootstrap before changing the route.
  // Seeing the HTML title alone does not mean its module scripts have run.
  await poll(() => js("import('/util.js').then(m=>m.state.me?.role==='admin'&&!location.hash.startsWith('#/t/'))"), 'automatic personal sign-in');
  pass('native-launch-and-private-library', { title: await js('document.title') });
  const build = await (await fetch(origin + '/studio/cowork-build.json')).json();
  assert.equal(build.plugin.id, 'cowork');
  pass('cowork-build-included', { patchCount: build.patches.length });
  await api('/api/local/links', { path: docs });
  const library = await api('/api/library');
  const doc = library.docs.find(d => d.fileName === 'native-smoke.hwpx'); assert(doc);
  await api(`/api/docs/${doc.id}/settings`, { editMode: 'realtime', track: 'tracked' }, 'PATCH');
  await js(`location.hash=${JSON.stringify('#/doc/' + doc.id)}; true`);
  await poll(() => js("!!document.querySelector('.editorhost iframe')?.contentWindow?.rhwpCowork?.ready"), 'cowork editor plugin');
  await poll(() => frame("return w.rhwpCowork.debug.paragraphs().some(t=>t.length>3) && !document.querySelector('.editorhost iframe').inert && !document.querySelector('.loadingpane, [data-testid=document-preview-progress], [data-testid=editor-lock]')"), 'editable document');
  await frame("w.rhwpStudio.automation.registerCommand({id:'ext:native-smoke',label:'native smoke',execute(s){w.__nativeSmoke=s}});await w.rhwpStudio.automation.execute('ext:native-smoke',{});return true;");
  pass('folder-document-and-plugin-open');
  const p = await frame("const texts=w.rhwpCowork.debug.paragraphs();const para=texts.findIndex(t=>t.length>3);const ih=w.__nativeSmoke.getInputHandler();ih.moveCursorTo({sectionIndex:0,paragraphIndex:para,charOffset:0});ih.focus();return {para,text:texts[para]};");
  const marker = 'Cowork입력확인ABC123'.repeat(8);
  for (const text of [...marker]) await send('Input.insertText', { text });
  await send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
  await send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
  await send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await send('Input.insertText', { text: '한' });
  const expected = marker + '한' + p.text;
  await poll(async () => (await frame(`return w.rhwpCowork.debug.paragraphs()[${p.para}]`)) === expected, 'continuous text and composition');
  pass('continuous-input-and-chromium-composition', { characters: marker.length + 1, nativeOsIme: false });
  const font = await frame(`const records=await w.queryLocalFonts();
    const used=new Set(w.__nativeSmoke.wasm.getDocumentFontCandidates());
    const loaded=new Set([...d.fonts].filter(f=>f.status==='loaded').map(f=>f.family.replace(/^['\"]|['\"]$/g,'')));
    const preferred=['Segoe Print','Apple Chancery','Baskerville','Georgia','Comic Sans MS'];
    const family=preferred.find(n=>records.some(r=>r.family===n)&&!used.has(n)&&!loaded.has(n));
    if(!family)throw Error('No unused installed test font');
    const ih=w.__nativeSmoke.getInputHandler();ih.moveCursorTo({sectionIndex:0,paragraphIndex:${p.para},charOffset:0});ih.focus();
    await w.rhwpStudio.automation.execute('edit:select-all',{});
    d.querySelector('#font-name').dispatchEvent(new w.PointerEvent('pointerdown',{bubbles:true}));
    d.querySelector('.font-picker-category[data-category="system"]').click();
    const item=[...d.querySelectorAll('.font-picker-option')].find(b=>b.textContent===family);
    if(!item)throw Error('Installed font missing from picker: '+family);item.click();return {family,count:records.length};`);
  await poll(() => frame(`return [...d.fonts].some(f=>f.status==='loaded'&&f.family.replace(/^['\"]|['\"]$/g,'')===${JSON.stringify(font.family)}) && w.__nativeSmoke.wasm.getCharPropertiesAt(0,${p.para},0).fontFamily===${JSON.stringify(font.family)}`), 'selected local FontFace');
  pass('local-font-permission-picker-and-loading', font);
  await poll(async () => {
    const ps = await api(`/api/docs/${doc.id}/paragraphs`);
    const rows = Array.isArray(ps) ? ps : ps.paragraphs;
    return rows?.some(r => (r.text || '').includes(marker + '한'));
  }, 'automatic save to private server');
  const JSZip = createRequire(path.join(payload, 'package.json'))('jszip');
  // The server API can show the queued revision before afterCommit writes the PC file.
  await poll(async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(copied));
    const sections = await Promise.all(Object.values(zip.files).filter(e => /^Contents\/section\d+\.xml$/.test(e.name)).map(e => e.async('string')));
    const header = await zip.file('Contents/header.xml').async('string');
    return sections.some(s => s.replace(/<[^>]*>/g, '').includes(marker + '한')) && header.includes(font.family);
  }, 'text and selected font committed to linked HWPX');
  pass('autosave-to-linked-hwpx-copy');
  await api(`/api/docs/${doc.id}/memos`, { ref: `s0/p${p.para}`, start: 0, end: 6, text: 'Native Cowork memo check' });
  const memos = await api(`/api/docs/${doc.id}/memos`);
  assert(JSON.stringify(memos).includes('Native Cowork memo check'));
  await poll(() => js("document.body.innerText.includes('Native Cowork memo check')"), 'memo in full cowork UI');
  pass('memo-api-and-cowork-ui');
  await send('Page.reload');
  await poll(() => frame(`return w.rhwpCowork?.debug.paragraphs().some(t=>t.includes(${JSON.stringify(marker + '한')}))`), 'saved document after reload');
  pass('reload-restores-saved-document');
  result.blockedExternalRequests = blockedExternal;
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  result.chromium = version.Browser;
  browserWs = await connect(version.webSocketDebuggerUrl);
  browserWs.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await poll(() => exited, 'clean app shutdown', 20000);
  await assert.rejects(fetch(origin + '/api/config', { signal: AbortSignal.timeout(2000) }));
  pass('app-close-stops-own-server');
  result.pass = true;
} catch (error) {
  result.error = error.stack; console.error(error.message); process.exitCode = 1;
  if (ws?.readyState === WebSocket.OPEN) result.failureUi = await js("({title:document.title,text:document.body.innerText.slice(0,2000),frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.contentDocument?.title,inert:f.inert,active:f.contentDocument?.activeElement?.tagName,paragraphs:f.contentWindow?.rhwpCowork?.debug.paragraphs().slice(0,5),text:f.contentDocument?.body?.innerText.slice(0,1000)}))})").catch(() => null);
} finally {
  ws?.close(); browserWs?.close();
  for (const pending of requests.values()) pending.reject(Error('Test ended')); requests.clear();
  if (!exited) { child.kill(); await poll(() => exited, 'test-owned process cleanup', 10000).catch(() => {}); }
  result.finishedAt = new Date().toISOString(); result.appProcessExited = exited;
  assert.equal(fileSha(fixture), fixtureSha256, 'Source fixture changed');
  fs.writeFileSync(path.join(out, 'native-result.json'), JSON.stringify(result, null, 2) + '\n');
}
