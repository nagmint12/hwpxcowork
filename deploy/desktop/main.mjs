import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopHost } from './host.mjs';
import { desktopPermission } from './permissions.mjs';
import { createBlockedCloseHandler } from './close-policy.mjs';
import { createServerTray } from './server-tray.mjs';
import { findCloudflared, installCloudflared } from './share.mjs';
import { savedMode, saveMode, modeFromArgs, relaunchArgs, personalTransport, savePersonalTransport, MODE_CHOICE, MODES, MODE_LABELS } from './mode.mjs';
import { RUNNER_AIS } from './runners.mjs';
import { officeFileArguments, openOfficeFile } from './office-files.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const product = 'HWPX Cowork';
const installedProduct = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).distribution !== 'portable';
app.setName(product);
if (process.platform === 'win32') app.setAppUserModelId(installedProduct ? 'kr.hwpx.cowork.desktop' : 'hwpx.cowork.office-tabs');
app.commandLine.removeSwitch('user-data-dir');
app.commandLine.removeSwitch('remote-debugging-port');
app.commandLine.removeSwitch('remote-debugging-pipe');
const githubRepository = 'https://github.com/nagmint12/hwpxcowork';
// New verification instances always start in a fresh directory. Join only
// forwards files to a running verification instance. Resume requires a one-use token.
const verificationFlags = ['--verification-profile', '--verification-join', '--verification-resume'];
const requestedVerification = verificationFlags.filter(flag => process.argv.includes(flag));
if (requestedVerification.length > 1) throw Error('한 가지 검증 실행 옵션만 지정해 주세요.');
const verificationFlag = requestedVerification[0];
const verificationAt = verificationFlag ? process.argv.indexOf(verificationFlag) : -1;
const verificationJoin = verificationFlag === '--verification-join';
const defaultProfile = path.join(app.getPath('appData'), installedProduct ? 'Hwpx Cowork' : 'Hwpx Cowork Office Tabs');
let profile = defaultProfile;
if (verificationAt >= 0) {
  const directory = process.argv[verificationAt + 1];
  if (!directory || !path.isAbsolute(directory)) throw Error('검증에는 절대경로의 프로필 폴더가 필요합니다.');
  const marker = path.join(directory, '.office-tabs-verification');
  const resume = path.join(directory, '.office-tabs-relaunch');
  if (verificationFlag === '--verification-profile') {
    if (fs.existsSync(directory)) throw Error('검증에는 아직 없는 새 프로필 폴더가 필요합니다.');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(marker, 'office-tabs', { mode: 0o600 });
  } else {
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'office-tabs') throw Error('HWPX Cowork 검증 실행에서 만든 프로필을 지정해 주세요.');
    if (!verificationJoin) {
      const token = process.argv[verificationAt + 2];
      if (!token || !fs.existsSync(resume) || fs.readFileSync(resume, 'utf8') !== token) throw Error('검증 앱 재시작을 확인할 수 없습니다.');
      fs.unlinkSync(resume);
    }
  }
  profile = fs.realpathSync(directory);
  if (!verificationJoin) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', '0');
  }
}
const sessionData = installedProduct ? profile : path.join(profile, 'browser');
fs.mkdirSync(sessionData, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', sessionData);
let editor; let runnerWin; let host; let quitting = false; let quittingNow = false; let mode = 'personal'; let shareBusy = false;
let serverTray;
let switchOnQuit = null;
function showEditor() {
  if (!editor || editor.isDestroyed()) return;
  if (editor.isMinimized()) editor.restore();
  editor.show();
  editor.focus();
}
const mac = process.platform === 'darwin';
const TITLES = { personal: `${product} · 내 문서`, shared: `${product} · 공동 작업`, runner: `${product} · AI 실행기` };
const SWITCH_QUESTION = { personal: '혼자 쓰기(개인용)로 바꿀까요?', shared: '여러 사람과 함께 쓰기(공동 작업용)로 바꿀까요?', runner: 'AI 실행기만 쓰는 방식으로 바꿀까요?' };
const ownFile = file => pathToFileURL(path.join(here, file)).href;
// 창 바탕(2026-11-18): 흰색, 어두운 테마면 검은색 — '여는 중' 화면(loading.html)·실행기 창과 같은 색
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff');
// 앱 아이콘(scripts/make-icons.mjs) — 처음 실행의 운영 방식 고르기 창에 쓴다
const appIcon = () => { try { const i = nativeImage.createFromPath(path.join(here, 'app-icon.png')); return i.isEmpty() ? undefined : i; } catch { return undefined; } };
const localPage = url => {
  try { const u = new URL(url); return !u.username && !u.password && u.protocol === 'http:' && (host?.portless ? u.origin === 'http://localhost'
    : !!host?.port && ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === host.port); } catch { return false; }
};
let officeReady = false;
let officeEpoch = 0;
let officeLeaving = false;
let approvedClose = false;
let pendingSave = null;
let pendingReceipt = null;
let officePickerOpen = false;
let fileOperation = Promise.resolve();
let reopenForFiles = false;
const args = process.argv.slice(app.isPackaged ? 1 : 2);
if (verificationAt >= 0) args.splice(args.indexOf(verificationFlag), verificationFlag === '--verification-resume' ? 3 : 2);
const pendingFiles = officeFileArguments(args, process.cwd());
function isOfficePage(url) { return localPage(url) && new URL(url).pathname === '/'; }
function officeFrame() {
  if (!editor || editor.isDestroyed() || editor.webContents.isDestroyed()) return null;
  const frame = editor.webContents.mainFrame;
  return frame && !frame.detached && isOfficePage(frame.url) ? frame : null;
}
function isOfficeSender(event) {
  const frame = officeFrame();
  return frame && event.sender === editor.webContents && event.senderFrame === frame;
}
function sendOfficeCommand(command) {
  if (officeReady && !officeLeaving) officeFrame()?.send('office-tabs:command', command);
}
ipcMain.on('office-tabs:ready', event => {
  if (!isOfficeSender(event)) return;
  officeReady = true;
  refreshMenus();
  drainOfficeFiles();
});
ipcMain.on('office-tabs:closed-preparation', (event, token, saved) => {
  if (isOfficeSender(event) && pendingSave?.token === token) pendingSave.finish(saved === true);
});
ipcMain.on('office-tabs:file-received', (event, token) => {
  if (isOfficeSender(event) && pendingReceipt?.token === token) pendingReceipt.finish(true);
});
ipcMain.on('office-tabs:pick-files', event => {
  if (isOfficeSender(event)) void chooseOfficeFiles().catch(showError);
});
ipcMain.on('office-tabs:application-menu', (event, position) => {
  if (!isOfficeSender(event) || !editor.isFocused()) return;
  const { width, height } = editor.getContentBounds();
  const zoom = editor.webContents.getZoomFactor();
  const options = { window: editor };
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
    const x = Math.round(position.x * zoom);
    const y = Math.round(position.y * zoom);
    if (x >= 0 && x < width && y >= 0 && y < height) Object.assign(options, { x, y });
  }
  Menu.getApplicationMenu()?.popup(options);
});

async function saveBeforeLeaving(action) {
  if (officeLeaving) return;
  const frame = officeFrame();
  if (!officeReady || !frame) { action(); return; }
  officeLeaving = true;
  refreshMenus();
  await fileOperation;
  const token = randomUUID();
  const saved = officeReady && frame === officeFrame() && await new Promise(resolve => {
    const finish = ok => { clearTimeout(timer); pendingSave = null; resolve(ok); };
    const timer = setTimeout(() => {
      try { if (frame === officeFrame()) frame.send('office-tabs:cancel-close', token); } catch { /* 창이 닫혔다 */ }
      finish(false);
      showError(Error('문서 저장을 확인하고 다시 시도해 주세요.'));
    }, 120000);
    pendingSave = { token, finish };
    try { frame.send('office-tabs:prepare-close', token); }
    catch { finish(false); }
  });
  officeLeaving = false;
  if (saved && frame === officeFrame() && officeReady) action();
  else { switchOnQuit = null; drainOfficeFiles(); }
  refreshMenus();
}

function enqueueOfficeFiles(filePaths) {
  if (filePaths.length && (officeLeaving || quitting)) reopenForFiles = true;
  pendingFiles.push(...filePaths);
  drainOfficeFiles();
}

function drainOfficeFiles() {
  if (!officeReady || officeLeaving || !pendingFiles.length || !officeFrame()) return;
  const selected = pendingFiles.splice(0);
  reopenForFiles = false;
  fileOperation = fileOperation.then(() => deliverOfficeFiles(selected)).catch(showError);
}

function sendOfficeFileReceipt(frame) {
  const token = randomUUID();
  return new Promise(resolve => {
    const finish = ok => { clearTimeout(timer); pendingReceipt = null; resolve(ok); };
    const timer = setTimeout(() => finish(false), 300000);
    pendingReceipt = { token, finish };
    try { frame.send('office-tabs:file-end', token); }
    catch { finish(false); }
  });
}

async function deliverOfficeFiles(selected) {
  const frame = officeFrame();
  if (!officeReady || !frame) { pendingFiles.unshift(...selected); return; }
  const epoch = officeEpoch;
  const available = () => officeReady && !quitting && officeEpoch === epoch && frame === officeFrame();
  const batch = randomUUID();
  const errors = [];
  let index = 0;
  for (; index < selected.length; index++) {
    if (!available()) break;
    const filePath = selected[index];
    let file;
    let started = false;
    let complete = false;
    try {
      file = await openOfficeFile(filePath);
      if (!available()) break;
      frame.send('office-tabs:file-start', { name: file.name, source: file.source, size: file.size, batch, index, total: selected.length });
      started = true;
      let sent = 0;
      for await (const chunk of file.stream()) {
        if (!available()) break;
        frame.send('office-tabs:file-chunk', chunk);
        sent += chunk.length;
      }
      complete = sent === file.size;
      if (available() && !complete) throw Error('파일을 읽는 동안 크기가 바뀌었습니다.');
    } catch (error) {
      errors.push(`${path.basename(filePath)}\n${error.code ? '파일을 읽을 수 없습니다.' : error.message}`);
    } finally {
      if (file) await file.close();
      if (started && !complete && available()) frame.send('office-tabs:file-end', null);
    }
    if (complete && available() && !await sendOfficeFileReceipt(frame)) {
      if (!available()) break;
      errors.push(`${path.basename(filePath)}\n편집기가 파일 열기 완료를 확인하지 못했습니다. 남은 파일을 다시 선택해 주세요.`);
      index = selected.length;
    }
  }
  if (!available()) {
    if (!quitting) {
      pendingFiles.unshift(...selected.slice(index));
      drainOfficeFiles();
    }
    return;
  }
  if (errors.length) await dialog.showMessageBox(editor, { type: 'error', message: '일부 문서를 열지 못했습니다.', detail: errors.join('\n\n') });
}

async function chooseOfficeFiles() {
  if (!officeReady || officeLeaving || officePickerOpen || !officeFrame()) return;
  officePickerOpen = true;
  try {
    const result = await dialog.showOpenDialog(editor, { title: 'HWPX 파일 열기', properties: ['openFile', 'multiSelections'], filters: [{ name: '한글 문서', extensions: ['hwpx'] }] });
    if (!result.canceled) enqueueOfficeFiles(result.filePaths);
  } finally { officePickerOpen = false; }
}
// '다른 서버' 토큰 보관(2026-11-17): Electron safeStorage — Windows 는 사용자 계정 DPAPI, Mac 은 키체인. 평문 저장으로 물러서지 않는다(runners.mjs)
const vault = {
  available() {
    try { return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'); }
    catch { return false; }
  },
  encrypt: text => safeStorage.encryptString(text).toString('base64'),
  decrypt: sealed => safeStorage.decryptString(Buffer.from(String(sealed), 'base64')),
};
function guardNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (host?.portless && localPage(url)) return { action: 'allow', overrideBrowserWindowOptions: {
      parent: win, webPreferences: { session: win.webContents.session, preload: path.join(here, 'editor-preload.cjs'),
        additionalArguments: ['--hwpx-personal-stdio'], sandbox: true, contextIsolation: true, nodeIntegration: false },
    } };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', child => guardNavigation(child));
  win.webContents.on('will-navigate', (event, url) => {
    if (!localPage(url) && url !== ownFile('loading.html') && !(mode === 'shared' && url === ownFile('server-console.html'))) event.preventDefault();
  });
}
function guardWindow(win) {
  guardNavigation(win);
  win.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => desktopPermission(win.webContents, contents, permission, origin, details, host?.port, host?.portless));
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(desktopPermission(win.webContents, contents, permission, details?.requestingUrl, details, host?.port, host?.portless)));
}
function routePersonalEditor(session) {
  session.protocol.handle('http', async req => {
    if (new URL(req.url).origin !== 'http://localhost') return session.fetch(req, { bypassCustomProtocolHandlers: true });
    if (!host?.pipe) return new Response(null, { status: 503 });
    const origin = req.headers.get('origin');
    if (origin && origin !== 'http://localhost') return new Response(null, { status: 403 });
    return host.fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal,
      ...(req.body ? { body: req.body, duplex: 'half' } : {}) });
  });
}
// ── AI 실행기 창(runners.html) — 혼자/함께 쓰기는 편집기 위의 작은 창, AI 실행기만 방식은 앱의 첫 창 ──
const runnerPage = () => (mode === 'runner' ? editor : runnerWin);
function showRunners() {
  if (!host) return;
  if (mode === 'runner') { if (editor && !editor.isDestroyed()) { if (editor.isMinimized()) editor.restore(); editor.show(); editor.focus(); } return; }
  if (runnerWin && !runnerWin.isDestroyed()) { runnerWin.focus(); return; }
  runnerWin = new BrowserWindow({ title: 'AI 실행기', parent: editor, width: 780, height: 720, minWidth: 560, minHeight: 480, autoHideMenuBar: true, backgroundColor: windowBackground(),
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
async function startAutoRunners(scope = 'all') {
  if (!host || quitting) return;
  const failed = await host.runners.startAuto(scope).catch(() => []);
  if (failed.length && !quitting) showRunners();   // 로그인이 풀렸거나 서버가 없으면 실행기 창에서 오류를 보인다
}
async function connectFolder() {
  if (host?.state.phase !== 'ready' || mode !== 'personal' || officeLeaving) return;
  const selected = await dialog.showOpenDialog(editor, { title: '문서가 있는 폴더 연결', properties: ['openDirectory', 'multiSelections'] });
  if (selected.canceled) return;
  try { for (const folder of selected.filePaths) await host.linkFolder(folder); }
  catch (error) { await dialog.showMessageBox(editor, { type: 'error', message: '폴더를 연결하지 못했습니다.', detail: error.message }); }
  finally { sendOfficeCommand('refresh-library'); }
}
let menuKey = '';
async function showAbout(window) {
  const options = {
    type: 'info', title: app.getName(), message: app.getName(),
    detail: `${app.getVersion()}\n\n${githubRepository}`,
    buttons: ['GitHub 바로가기', '확인'], defaultId: 1, cancelId: 1, noLink: true,
  };
  const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  if (response === 0) await shell.openExternal(githubRepository);
}
function refreshMenus() {
  const s = host?.snapshot() || {};
  const key = `${s.phase}|${s.share}|${s.aiSupported}|${(host?.runners.running() || 0) > 0}|${shareBusy}|${officeReady}|${officeLeaving}`;
  if (key !== menuKey) { menuKey = key; menus(); }
}
function menus() {
  const state = host?.snapshot() || {};
  const shared = mode === 'shared'; const personal = mode === 'personal';
  const tabs = officeReady && !officeLeaving;
  const editorCommand = command => (_item, window) => { if (window === editor) sendOfficeCommand(command); };
  const running = host?.runners.running() || 0;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: product, submenu: [
      { label: '튜토리얼', enabled: tabs, click: editorCommand('tutorial') },
      { label: '소개 영상 보기', enabled: tabs, click: editorCommand('intro') },
      { type: 'separator' },
      { label: `${product} 정보`, click: (_item, window) => void showAbout(window).catch(showError) }, { label: '다운로드', click: () => void shell.openExternal(`${githubRepository}/releases/latest`).catch(showError) }, { type: 'separator' },
      { label: '운영 방식 바꾸기', enabled: !officeLeaving, submenu: MODES.filter(m => m !== mode).map(m => ({ label: `${MODE_LABELS[m]}…`, click: () => void switchMode(m) })) }, { type: 'separator' },
      { role: 'hide', label: '가리기', visible: mac }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [
      { label: '새 문서', accelerator: 'CmdOrCtrl+N', enabled: tabs, click: editorCommand('new-document') },
      { label: '파일 열기…', accelerator: 'CmdOrCtrl+O', enabled: tabs, click: (_item, window) => {
        if (window === editor) void chooseOfficeFiles().catch(showError);
      } },
      { label: '문서 폴더 연결…', accelerator: 'CmdOrCtrl+Shift+O', visible: personal, enabled: tabs, click: (_item, window) => {
        if (window === editor) void connectFolder();
      } },
      { type: 'separator' },
      { label: '탭 닫기', accelerator: 'CmdOrCtrl+W', enabled: !officeLeaving, click: (_item, window) => {
        if (window === editor && mode !== 'runner') sendOfficeCommand('close-tab');
        else window?.close();
      } },
      { label: '창 닫기', accelerator: 'CmdOrCtrl+Shift+W', click: (_item, window) => window?.close() },
    ] },
    { label: '개인 연결', visible: personal, submenu: [
      { label: '포트 없이 편집 (stdio)', type: 'radio', enabled: !officeLeaving, checked: !!host?.portless, click: () => void changeTransport('stdio') },
      { label: '브라우저 연결 (127.0.0.1)', type: 'radio', enabled: !officeLeaving, checked: !host?.portless, click: () => void changeTransport('loopback') },
      { label: '기본 브라우저에서 열기', enabled: state.phase === 'ready' && !!host?.port && !host?.portless, click: () => void openPersonalBrowser().catch(showError) },
      { type: 'separator' }, { label: 'AI 앱의 MCP 설정 복사…', enabled: !!host?.portless && state.phase === 'ready', click: () => void copyMcpConfig() },
    ] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [
      { label: '문서함', accelerator: 'CmdOrCtrl+Shift+L', enabled: tabs, click: editorCommand('library') },
      { label: '다음 탭', accelerator: 'Ctrl+Tab', enabled: tabs, click: editorCommand('next-tab') },
      { label: '이전 탭', accelerator: 'Ctrl+Shift+Tab', enabled: tabs, click: editorCommand('previous-tab') },
      { type: 'separator' },
      { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: (_item, window) => {
        if (window === editor) void saveBeforeLeaving(() => window.webContents.reload());
        else window?.webContents.reload();
      } },
      { role: 'togglefullscreen', label: '전체 화면' }, { role: 'resetzoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
    ] },
    { label: 'AI', visible: state.aiSupported === true || mode === 'runner', submenu: [
      { label: '실행기 관리…', click: showRunners },
      { label: '실행기 모두 끄기', enabled: running > 0, click: () => void host?.runners.stopAll().catch(showError) },
    ] },
    { label: '함께 쓰기', visible: shared, submenu: [
      { label: '서버 관리', enabled: !officeLeaving, click: () => void saveBeforeLeaving(() => void editor?.loadFile(path.join(here, 'server-console.html')).catch(showError)) },
      { label: '참여자 관리…', enabled: !officeLeaving && state.phase === 'ready', click: openAdmin },
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
  switchOnQuit = () => saveMode(app.getPath('userData'), next);
  app.quit();
}
async function changeTransport(next) {
  if ((next === 'stdio') === host.portless) return;
  const { response } = await dialog.showMessageBox(editor, { type: 'question', message: next === 'stdio' ? '포트 없이 다시 열까요?' : '127.0.0.1 서버로 다시 열까요?',
    detail: '현재 문서함, 연결 폴더, AI 검토 설정을 그대로 사용합니다.', buttons: ['취소', '저장 후 다시 열기'], defaultId: 1, cancelId: 0 });
  if (response !== 1) { menus(); return; }
  switchOnQuit = () => savePersonalTransport(host.userdata, next);
  app.quit();
}
async function openPersonalBrowser() {
  if (mode !== 'personal' || host?.portless || host?.state.phase !== 'ready' || !host.port) return;
  const token = host.freshToken();
  if (!token) throw Error('개인 문서함 접속 정보를 확인하지 못했습니다.');
  await shell.openExternal(`http://127.0.0.1:${host.port}/?teaser=0#/t/${encodeURIComponent(token)}`);
}
async function copyMcpConfig() {
  const { response } = await dialog.showMessageBox(editor, { type: 'info', message: '어느 형식으로 복사할까요?',
    detail: '개인용 앱을 열어 둔 상태에서 로컬 AI 클라이언트의 MCP 설정에 붙여 넣으세요. 같은 문서함과 편집 검토 규칙을 사용합니다.',
    buttons: ['Codex (TOML)', 'MCP 설정 (JSON)', '취소'], defaultId: 0, cancelId: 2 });
  const args = [path.join(host.payload, 'server/personal-stdio.js'), '--profile', host.userdata];
  const name = installedProduct ? 'hwpx_personal' : 'hwpx_office_tabs';
  if (response === 0) clipboard.writeText(`[mcp_servers.${name}]\ncommand = ` + JSON.stringify(host.node) + '\nargs = ' + JSON.stringify(args) + '\n');
  if (response === 1) clipboard.writeText(JSON.stringify({ mcpServers: { [name]: { command: host.node, args } } }, null, 2));
}
function consoleState() {
  const { phase, message, share, shareUrl, shareSupported, aiSupported } = host.snapshot();
  return { phase, message, share, shareUrl, shareSupported, aiSupported, address: host.port ? host.origin : '' };
}
ipcMain.handle('server-console-action', async (event, action) => {
  if (mode !== 'shared' || !editor || event.sender !== editor.webContents || event.senderFrame !== editor.webContents.mainFrame ||
      event.senderFrame.url !== ownFile('server-console.html')) throw Error('공동 작업 서버 관리 화면에서 실행하세요.');
  try {
    const phase = host.state.phase;
    if (action === 'start' && ['stopped', 'error'].includes(phase)) { await host.start(); void startAutoRunners('local'); }
    if (action === 'stop' && ['ready', 'stop-error'].includes(phase)) await host.stopService();
    if (action === 'open' && phase === 'ready') await editor.loadURL(host.origin + '/?teaser=0#/t/' + encodeURIComponent(host.freshToken()));
    if (action === 'ai') showRunners();
    if (action === 'copy') copyShare();
    if (action === 'share' && phase === 'ready') { if (host.state.share === 'on') await host.closeShare(); else await openShare(); }
    return { state: consoleState() };
  } catch (error) { return { error: error.message, state: consoleState() }; }
});
function openAdmin() {
  if (!host?.port) return;
  const frame = officeFrame();
  if (frame) void frame.executeJavaScript("location.hash = '#/admin'").catch(showError);
  else void editor?.loadURL(`http://localhost:${host.port}/#/admin`).catch(showError);
}
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
function showError(error) {
  const options = { type: 'error', message: '작업을 마치지 못했습니다.', detail: error.message };
  void (editor && !editor.isDestroyed() ? dialog.showMessageBox(editor, options) : dialog.showMessageBox(options));
}
async function bootstrap() {
  const resources = process.resourcesPath;
  const payload = path.join(resources, 'payload', 'app');
  const node = path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const given = modeFromArgs(process.argv);
  const appData = app.getPath('userData');
  const lastMode = given || savedMode(appData);
  if (!lastMode && installedProduct && verificationAt < 0) {
    const choice = dialog.showMessageBoxSync({ type: 'question', icon: appIcon(), title: product, message: MODE_CHOICE.message, detail: MODE_CHOICE.detail, buttons: MODE_CHOICE.buttons, defaultId: 0, cancelId: 0, noLink: true });
    mode = MODE_CHOICE.modes[choice] || 'personal';
    saveMode(appData, mode);
  } else mode = lastMode || 'personal';
  const userdata = path.join(appData, mode);
  // 다른 방식에서 이미 받은 Codex·Claude CLI(<앱 설정>/<방식>/tools)도 찾게 한다 — 방식을 바꿔도 다시 받지 않게
  const transport = mode === 'personal' ? personalTransport(userdata) : 'loopback';
  host = new DesktopHost({ payload, node, userdata, mode, transport, vault, otherUserdata: MODES.filter(m => m !== mode).map(m => path.join(appData, m)) });
  host.runners.on('change', pushRunnerState);
  const runnerOnly = mode === 'runner';
  if (process.platform === 'win32' && !runnerOnly) {
    serverTray = createServerTray({ Tray, Menu, icon: appIcon().resize({ width: 24, height: 24 }), mode, portless: host.portless, showWindow: showEditor, quit: () => app.quit() });
  }
  editor = new BrowserWindow({ title: TITLES[mode], width: runnerOnly ? 880 : 1440, height: runnerOnly ? 780 : 940, minWidth: runnerOnly ? 560 : 900, minHeight: runnerOnly ? 520 : 650, backgroundColor: windowBackground(),
    autoHideMenuBar: process.platform === 'win32' && mode === 'personal',
    webPreferences: { preload: path.join(here, runnerOnly ? 'preload.cjs' : 'editor-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
      ...(host.portless ? { partition: installedProduct ? 'persist:hwpx-personal-stdio' : 'persist:hwpx-office-tabs-stdio', additionalArguments: ['--hwpx-personal-stdio'] } : {}) } });
  if (host.portless) routePersonalEditor(editor.webContents.session);
  guardWindow(editor); refreshMenus();
  if (process.platform === 'win32' && !runnerOnly) {
    editor.webContents.on('did-finish-load', () => {
      const inWorkspace = Boolean(officeFrame());
      editor.setAutoHideMenuBar(inWorkspace || mode === 'personal');
      editor.setMenuBarVisibility(!inWorkspace && mode === 'shared');
    });
  }
  const clearOfficePage = () => {
    officeReady = false;
    officeEpoch++;
    pendingSave?.finish(false);
    pendingReceipt?.finish(false);
    refreshMenus();
  };
  editor.webContents.on('did-start-navigation', (event, details, sameDocument, mainFrame) => {
    const navigation = typeof details === 'object' ? details : event;
    if ((navigation.isMainFrame ?? mainFrame) && !(navigation.isSameDocument ?? navigation.isInPlace ?? sameDocument)) clearOfficePage();
  });
  editor.webContents.on('render-process-gone', clearOfficePage);
  editor.on('close', event => {
    if (approvedClose) { approvedClose = false; return; }
    if (!officeReady || !officeFrame()) return;
    event.preventDefault();
    void saveBeforeLeaving(() => { approvedClose = true; editor.close(); });
  });
  // 웹 편집기의 beforeunload 저장 경고가 창 닫기를 막을 수 있게 서버 종료보다 먼저 닫기를 시도한다.
  if (!runnerOnly) editor.webContents.on('will-prevent-unload', createBlockedCloseHandler({
    confirmDiscard: () => { const discard = dialog.showMessageBoxSync(editor, { type: 'warning',
      message: '저장되지 않은 변경 내용을 버리시겠습니까?',
      detail: '이미 자동 저장된 내용은 유지됩니다. 아직 저장되지 않은 변경 내용은 사라집니다.',
      buttons: ['취소', '변경 내용 버리기'], defaultId: 0, cancelId: 0, noLink: true,
    }) === 1; if (!discard) { switchOnQuit = null; drainOfficeFiles(); menus(); } return discard; },
  }));
  editor.on('closed', () => { editor = null; app.quit(); });
  host.on('state', state => {
    if (!quitting) serverTray?.update(state.phase);
    refreshMenus(); pushRunnerState();
    if (mode === 'shared' && editor && !editor.isDestroyed() && editor.webContents.getURL() === ownFile('server-console.html')) {
      editor.webContents.send('server-console-state', consoleState());
    } else if (state.phase === 'error' && !quitting && editor) showError(new Error(state.message));
  });
  if (mode === 'shared') {
    host.publish({ phase: 'stopped' });
    await editor.loadFile(path.join(here, 'server-console.html'));
    void startAutoRunners('remote');
    return;
  }
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
if (!app.requestSingleInstanceLock({ officeFiles: pendingFiles })) app.quit();
else if (verificationJoin) app.exit(2);
else {
  app.on('second-instance', (_event, _argv, _directory, data) => {
    showEditor();
    if (Array.isArray(data?.officeFiles)) enqueueOfficeFiles(data.officeFiles.filter(file => typeof file === 'string' && path.isAbsolute(file)));
  });
  app.whenReady().then(bootstrap).catch(showError);
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
  serverTray?.update('stopping');
  void (async () => {
    try {
      await host?.stop();
      if (switchOnQuit || (reopenForFiles && pendingFiles.length)) {
        switchOnQuit?.();
        const next = relaunchArgs(args).filter(argument => !/\.hwpx$/i.test(argument));
        if (verificationAt >= 0) {
          const token = randomUUID();
          fs.writeFileSync(path.join(profile, '.office-tabs-relaunch'), token, { mode: 0o600 });
          next.push('--verification-resume', profile, token);
        }
        app.relaunch({ args: [...next, ...pendingFiles] });
      }
      quittingNow = true; app.quit();
    }
    catch (error) { quitting = false; serverTray?.update('error'); await dialog.showMessageBox({ type: 'warning', message: '저장을 마칠 때까지 기다려 주세요.', detail: error.message }); }
  })();
});
app.on('will-quit', () => serverTray?.destroy());
