import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopHost } from './host.mjs';
import { desktopPermission } from './permissions.mjs';
import { createBlockedCloseHandler } from './close-policy.mjs';
import { findCloudflared, installCloudflared } from './share.mjs';
import { savedMode, saveMode, modeFromArgs, relaunchArgs, MODE_CHOICE, MODES, MODE_LABELS } from './mode.mjs';
import { RUNNER_AIS } from './runners.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('Hwpx Cowork');
// Explicit opt-in for native release validation. A fresh directory is mandatory
// so a test run cannot attach to an existing user's settings or documents.
const verificationAt = process.argv.indexOf('--verification-profile');
if (verificationAt >= 0) {
  const directory = process.argv[verificationAt + 1];
  if (!directory || !path.isAbsolute(directory) || fs.existsSync(directory)) throw Error('검증에는 아직 없는 절대경로의 새 프로필 폴더가 필요합니다.');
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', directory);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
let editor; let runnerWin; let host; let quitting = false; let quittingNow = false; let mode = 'personal'; let shareBusy = false;
const mac = process.platform === 'darwin';
const TITLES = { personal: 'Hwpx Cowork · 내 문서', shared: 'Hwpx Cowork · 공동 작업', runner: 'Hwpx Cowork · AI 실행기' };
const SWITCH_QUESTION = { personal: '혼자 쓰기(개인용)로 바꿀까요?', shared: '여러 사람과 함께 쓰기(공동 작업용)로 바꿀까요?', runner: 'AI 실행기만 쓰는 방식으로 바꿀까요?' };
const ownFile = file => pathToFileURL(path.join(here, file)).href;
const localPage = url => { try { const u = new URL(url); return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === host?.port; } catch { return false; } };
// '다른 서버' 토큰 보관(2026-11-17): Electron safeStorage — Windows 는 사용자 계정 DPAPI, Mac 은 키체인. 평문 저장으로 물러서지 않는다(runners.mjs)
const vault = {
  available() {
    try { return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'); }
    catch { return false; }
  },
  encrypt: text => safeStorage.encryptString(text).toString('base64'),
  decrypt: sealed => safeStorage.decryptString(Buffer.from(String(sealed), 'base64')),
};
function guardWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!localPage(url) && !url.startsWith(ownFile('loading.html'))) event.preventDefault(); });
  win.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => desktopPermission(win.webContents, contents, permission, origin, details, host?.port));
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(desktopPermission(win.webContents, contents, permission, details?.requestingUrl, details, host?.port)));
}
// ── AI 실행기 창(runners.html) — 혼자/함께 쓰기는 편집기 위의 작은 창, AI 실행기만 방식은 앱의 첫 창 ──
const runnerPage = () => (mode === 'runner' ? editor : runnerWin);
function showRunners() {
  if (!host) return;
  if (mode === 'runner') { if (editor && !editor.isDestroyed()) { if (editor.isMinimized()) editor.restore(); editor.show(); editor.focus(); } return; }
  if (runnerWin && !runnerWin.isDestroyed()) { runnerWin.focus(); return; }
  runnerWin = new BrowserWindow({ title: 'AI 실행기', parent: editor, width: 780, height: 720, minWidth: 560, minHeight: 480, autoHideMenuBar: true, backgroundColor: '#f5f6f2',
    webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  runnerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  runnerWin.webContents.on('will-navigate', e => e.preventDefault());
  runnerWin.on('closed', () => { runnerWin = null; });
  void runnerWin.loadFile(path.join(here, 'runners.html'));
}
function runnerState() {
  const s = host.snapshot();
  return { mode, modeLabel: MODE_LABELS[mode], place: host.place, phase: s.phase, aiSupported: s.aiSupported, aiSupportMessage: s.aiSupportMessage,
    ais: Object.entries(RUNNER_AIS).map(([id, k]) => ({ id, label: k.label, account: k.account, managed: k.managed, mcp: k.mcp, command: k.command })),
    ...host.runners.snapshot() };
}
let pushQueued = false;
function pushRunnerState() {
  if (pushQueued) return;
  pushQueued = true;
  setTimeout(() => {
    pushQueued = false;
    if (!host) return;
    const page = runnerPage();
    if (page && !page.isDestroyed()) page.webContents.send('desktop-state', runnerState());
    refreshMenus();
  }, 80);
}
async function startAutoRunners() {
  if (!host || quitting) return;
  const failed = await host.runners.startAuto().catch(() => []);
  if (failed.length && !quitting) showRunners();   // 로그인이 풀렸거나 서버가 없으면 실행기 창에서 오류를 보인다
}
async function connectFolder() {
  if (host?.state.phase !== 'ready' || mode !== 'personal') return;
  const selected = await dialog.showOpenDialog(editor, { title: '문서가 있는 폴더 연결', properties: ['openDirectory', 'multiSelections'] });
  if (selected.canceled) return;
  try {
    for (const folder of selected.filePaths) await host.linkFolder(folder);
    editor.webContents.reload();
  } catch (error) { await dialog.showMessageBox(editor, { type: 'error', message: '폴더를 연결하지 못했습니다.', detail: error.message }); }
}
let menuKey = '';
function refreshMenus() {
  const s = host?.snapshot() || {};
  const key = `${s.phase}|${s.share}|${s.aiSupported}|${(host?.runners.running() || 0) > 0}|${shareBusy}`;
  if (key !== menuKey) { menuKey = key; menus(); }
}
function menus() {
  const state = host?.snapshot() || {};
  const shared = mode === 'shared'; const personal = mode === 'personal';
  const running = host?.runners.running() || 0;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hwpx Cowork', submenu: [{ role: 'about', label: 'Hwpx Cowork 정보' }, { type: 'separator' },
      { label: '운영 방식 바꾸기', submenu: MODES.filter(m => m !== mode).map(m => ({ label: `${MODE_LABELS[m]}…`, click: () => void switchMode(m) })) }, { type: 'separator' },
      { role: 'hide', label: '가리기', visible: mac }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [{ label: '문서 폴더 연결…', accelerator: 'CmdOrCtrl+Shift+O', visible: personal, click: connectFolder }, { type: 'separator', visible: personal }, { role: 'close', label: '창 닫기' }] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'togglefullscreen', label: '전체 화면' }, { role: 'resetzoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }] },
    { label: 'AI', visible: state.aiSupported === true || mode === 'runner', submenu: [
      { label: '실행기 관리…', click: showRunners },
      { label: '실행기 모두 끄기', enabled: running > 0, click: () => void host?.runners.stopAll().catch(showError) },
    ] },
    { label: '함께 쓰기', visible: shared, submenu: [
      { label: '참여자 관리…', enabled: state.phase === 'ready', click: openAdmin },
      { type: 'separator' },
      { label: '외부 접속 열기…', visible: state.shareSupported === true, enabled: state.phase === 'ready' && !['opening', 'on'].includes(state.share) && !shareBusy, click: () => void openShare() },
      { label: '외부 접속 주소 복사', visible: state.share === 'on', click: copyShare },
      { label: '외부 접속 닫기', visible: ['opening', 'on'].includes(state.share), click: () => void host?.closeShare().catch(showError) },
    ] },
  ]));
}
async function switchMode(next) {
  if (!MODES.includes(next) || next === mode) return;
  const { response } = await dialog.showMessageBox(editor, { type: 'question', message: SWITCH_QUESTION[next],
    detail: '앱을 다시 시작합니다. 방식마다 문서와 설정은 따로 보관되며 지워지지 않습니다. 켜 둔 AI 실행기는 정상 종료합니다.', buttons: ['취소', '바꾸고 다시 시작'], defaultId: 1, cancelId: 0, noLink: true });
  if (response !== 1) return;
  saveMode(app.getPath('userData'), next);
  app.relaunch({ args: relaunchArgs(process.argv.slice(1)) });
  app.quit();
}
function openAdmin() { if (host?.port) void editor?.loadURL(`http://localhost:${host.port}/#/admin`); }
function copyShare() { const url = host?.snapshot().shareUrl; if (url) clipboard.writeText(url + '/'); }
async function openShare() {
  if (shareBusy || !host) return;
  shareBusy = true; menus();
  try {
    let exe = findCloudflared(host.userdata);
    if (!exe) {
      const { response } = await dialog.showMessageBox(editor, { type: 'question', message: '외부 접속 프로그램을 받을까요?',
        detail: '다른 PC에서 접속할 주소를 만들려면 Cloudflare의 무료 터널 프로그램(cloudflared, 약 60MB)이 필요합니다. 계정은 필요 없습니다.\n\nCloudflare 공식 배포 파일을 받아 서명을 확인한 뒤 이 앱의 설정 폴더에만 둡니다.',
        buttons: ['취소', '받기'], defaultId: 1, cancelId: 0, noLink: true });
      if (response !== 1) return;
      host.publish({ message: 'cloudflared를 받는 중입니다…' });
      exe = await installCloudflared(host.userdata);
    }
    const { response } = await dialog.showMessageBox(editor, { type: 'warning', message: '이 PC의 서버를 인터넷 주소로 엽니다',
      detail: '주소를 아는 사람은 접속 화면을 볼 수 있고, 문서는 관리자가 추가한 참여자만 각자의 토큰으로 엽니다.\n\n앱을 끄거나 [함께 쓰기 → 외부 접속 닫기]를 누르면 닫힙니다. 열 때마다 주소가 바뀝니다.',
      buttons: ['취소', '열기'], defaultId: 1, cancelId: 0, noLink: true });
    if (response !== 1) return;
    const url = await host.openShare(exe);
    const done = await dialog.showMessageBox(editor, { type: 'info', message: '외부 접속 주소가 열렸습니다',
      detail: `${url}/\n\n참여자에게 이 주소와 각자의 토큰을 알려 주세요. 참여자는 [함께 쓰기 → 참여자 관리]에서 추가합니다.`,
      buttons: ['주소 복사', '닫기'], defaultId: 0, cancelId: 1, noLink: true });
    if (done.response === 0) clipboard.writeText(url + '/');
  } catch (error) { showError(error); }
  finally { shareBusy = false; menus(); }
}
function showError(error) { void dialog.showMessageBox(editor, { type: 'error', message: '작업을 마치지 못했습니다.', detail: error.message }); }
async function bootstrap() {
  const resources = process.resourcesPath;
  const development = !app.isPackaged;
  const payload = development && process.env.HWPX_DESKTOP_PAYLOAD ? path.resolve(process.env.HWPX_DESKTOP_PAYLOAD) : path.join(resources, 'payload', 'app');
  const node = development && process.env.HWPX_DESKTOP_NODE ? path.resolve(process.env.HWPX_DESKTOP_NODE) : path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  // 운영 방식: 명령줄 --mode → 저장한 방식 → 처음이면 묻는다(취소하면 혼자 쓰기)
  const given = modeFromArgs(process.argv) || (verificationAt >= 0 ? 'personal' : null);   // 검증 실행은 묻지 않는다
  const appData = app.getPath('userData');
  mode = given || savedMode(appData);
  if (!mode) {
    const choice = dialog.showMessageBoxSync({ type: 'question', title: 'Hwpx Cowork', message: MODE_CHOICE.message, detail: MODE_CHOICE.detail, buttons: MODE_CHOICE.buttons, defaultId: 0, cancelId: 0, noLink: true });
    mode = MODE_CHOICE.modes[choice] || 'personal';
    saveMode(appData, mode);
  }
  const userdata = verificationAt < 0 && development && process.env.HWPX_DESKTOP_USERDATA ? path.resolve(process.env.HWPX_DESKTOP_USERDATA) : path.join(appData, mode);
  // 다른 방식에서 이미 받은 Codex·Claude CLI(<앱 설정>/<방식>/tools)도 찾게 한다 — 방식을 바꿔도 다시 받지 않게
  host = new DesktopHost({ payload, node, userdata, mode, vault, otherUserdata: MODES.filter(m => m !== mode).map(m => path.join(appData, m)) });
  host.runners.on('change', pushRunnerState);
  const runnerOnly = mode === 'runner';
  editor = new BrowserWindow({ title: TITLES[mode], width: runnerOnly ? 880 : 1440, height: runnerOnly ? 780 : 940, minWidth: runnerOnly ? 560 : 900, minHeight: runnerOnly ? 520 : 650, backgroundColor: '#f5f6f2',
    webPreferences: { preload: path.join(here, runnerOnly ? 'preload.cjs' : 'editor-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  guardWindow(editor); refreshMenus();
  // 웹 편집기의 beforeunload 저장 경고가 창 닫기를 막을 수 있게 서버 종료보다 먼저 닫기를 시도한다.
  if (!runnerOnly) editor.webContents.on('will-prevent-unload', createBlockedCloseHandler({
    confirmDiscard: () => dialog.showMessageBoxSync(editor, { type: 'warning',
      message: '저장되지 않은 변경 내용을 버리시겠습니까?',
      detail: '이미 자동 저장된 내용은 유지됩니다. 아직 저장되지 않은 변경 내용은 사라집니다.',
      buttons: ['취소', '변경 내용 버리기'], defaultId: 0, cancelId: 0, noLink: true,
    }) === 1,
  }));
  editor.on('closed', () => { editor = null; app.quit(); });
  host.on('state', state => {
    refreshMenus(); pushRunnerState();
    if (state.phase === 'error') showError(new Error(state.message));
  });
  if (runnerOnly) {   // AI 실행기만: 서버 없이 실행기 창이 곧 앱 창
    await host.start();
    await editor.loadFile(path.join(here, 'runners.html'));
    void startAutoRunners();
    return;
  }
  await editor.loadFile(path.join(here, 'loading.html'));
  try {
    const url = await host.start();
    if (quitting) return;
    await editor.loadURL(url);
    void startAutoRunners();
  } catch (error) {
    if (quitting) return;
    await dialog.showMessageBox(editor, { type: 'error', message: '개인 편집기를 열지 못했습니다.', detail: error.message, buttons: ['닫기'] });
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (editor) { if (editor.isMinimized()) editor.restore(); editor.show(); editor.focus(); } });
  app.whenReady().then(bootstrap);
}
// 실행기 창이 부르는 일 — 보낸 곳이 우리 runners.html 일 때만. 토큰은 'add-server' 로 한 번 들어와 암호화해 저장하고, 화면에는 다시 보내지 않는다
async function runnerAction(action, value) {
  const runners = host.runners;
  const id = String(value ?? '');
  switch (action) {
    case 'state': return { state: runnerState() };
    case 'add-server': return { server: await runners.addServer({ url: value?.url, token: value?.token }) };
    case 'remove-server': runners.removeServer(id); return {};
    case 'open-server': await shell.openExternal(runners.serverUrl(id)); return {};
    case 'add-runner': {
      const runner = runners.addRunner({ ai: value?.ai, server: value?.server, autoStart: value?.autoStart !== false, mcp: value?.mcp });
      if (value?.start !== false) void runners.start(runner.id).catch(() => { /* 상태·기록에 남는다 */ });
      return { runner };
    }
    case 'update-runner': return { runner: runners.updateRunner(String(value?.id ?? ''), { autoStart: value?.autoStart, mcp: value?.mcp }) };
    case 'remove-runner': await runners.removeRunner(id); return {};
    case 'start': void runners.start(id).catch(() => { /* 상태·기록에 남는다 */ }); return {};
    case 'stop': await runners.stop(id); return {};
    case 'stop-all': await runners.stopAll(); return {};
    case 'log': return { lines: runners.lines(id) };
    case 'open-logs': fs.mkdirSync(runners.logDir, { recursive: true }); await shell.openPath(runners.logDir); return {};
    case 'close': if (mode !== 'runner') runnerWin?.close(); return {};
    default: throw new Error('지원하지 않는 요청입니다.');
  }
}
ipcMain.handle('desktop-action', async (event, action, value) => {
  const page = runnerPage();
  if (!host || !page || page.isDestroyed() || event.sender !== page.webContents || event.senderFrame?.url !== ownFile('runners.html')) throw new Error('지원하지 않는 요청입니다.');
  try { return { ok: true, ...(await runnerAction(String(action), value)) }; }
  catch (error) { return { ok: false, message: error.message }; }
});
app.on('before-quit', event => {
  if (quittingNow) return;
  event.preventDefault(); if (quitting) return;
  if (editor && !editor.isDestroyed()) { editor.close(); return; }
  quitting = true;
  void (async () => {
    try { await host?.stop(); quittingNow = true; app.quit(); }
    catch (error) { quitting = false; await dialog.showMessageBox(editor, { type: 'warning', message: '저장을 마칠 때까지 기다려 주세요.', detail: error.message }); }
  })();
});
