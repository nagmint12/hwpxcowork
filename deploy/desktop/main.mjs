import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopHost } from './host.mjs';
import { desktopPermission } from './permissions.mjs';
import { createBlockedCloseHandler } from './close-policy.mjs';
import { findCloudflared, installCloudflared } from './share.mjs';
import { savedMode, saveMode, modeFromArgs, relaunchArgs, MODE_CHOICE } from './mode.mjs';
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
let editor; let settings; let host; let quitting = false; let quittingNow = false; let mode = 'personal'; let shareBusy = false;
const mac = process.platform === 'darwin';
const ownFile = file => pathToFileURL(path.join(here, file)).href;
const localPage = url => { try { const u = new URL(url); return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === host?.port; } catch { return false; } };
function guardWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!localPage(url) && !url.startsWith(ownFile('loading.html'))) event.preventDefault(); });
  win.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => desktopPermission(win.webContents, contents, permission, origin, details, host?.port));
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(desktopPermission(win.webContents, contents, permission, details?.requestingUrl, details, host?.port)));
}
function showAi() {
  if (!host?.snapshot().aiSupported) return;
  if (settings && !settings.isDestroyed()) { settings.focus(); return; }
  settings = new BrowserWindow({ title: '내 AI 연결', parent: editor, width: 520, height: 560, resizable: false, backgroundColor: '#f5f6f2', webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  settings.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settings.webContents.on('will-navigate', e => e.preventDefault());
  settings.on('closed', () => { settings = null; });
  void settings.loadFile(path.join(here, 'ai.html'));
}
async function connectFolder() {
  if (host?.state.phase !== 'ready') return;
  const selected = await dialog.showOpenDialog(editor, { title: '문서가 있는 폴더 연결', properties: ['openDirectory', 'multiSelections'] });
  if (selected.canceled) return;
  try {
    for (const folder of selected.filePaths) await host.linkFolder(folder);
    editor.webContents.reload();
  } catch (error) { await dialog.showMessageBox(editor, { type: 'error', message: '폴더를 연결하지 못했습니다.', detail: error.message }); }
}
function menus() {
  const aiSupported = host?.snapshot().aiSupported === true;
  const state = host?.snapshot() || {};
  const shared = mode === 'shared';
  const other = shared ? '혼자 쓰기(개인용)' : '여러 사람과 함께 쓰기(공동 작업용)';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hwpx Cowork', submenu: [{ role: 'about', label: 'Hwpx Cowork 정보' }, { type: 'separator' }, { label: '내 AI 연결…', visible: aiSupported, click: showAi }, { type: 'separator', visible: aiSupported },
      { label: `운영 방식 바꾸기 → ${other}…`, click: () => void switchMode() }, { type: 'separator' },
      { role: 'hide', label: '가리기', visible: mac }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [{ label: '문서 폴더 연결…', accelerator: 'CmdOrCtrl+Shift+O', visible: !shared, click: connectFolder }, { type: 'separator', visible: !shared }, { role: 'close', label: '창 닫기' }] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'togglefullscreen', label: '전체 화면' }, { role: 'resetzoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }] },
    { label: 'AI', visible: aiSupported, submenu: [{ label: 'ChatGPT·Claude 연결…', click: showAi }, { label: 'AI 연결 끊기', click: () => void host?.disconnectAi().catch(showError) }] },
    { label: '함께 쓰기', visible: shared, submenu: [
      { label: '참여자 관리…', enabled: state.phase === 'ready', click: openAdmin },
      { type: 'separator' },
      { label: '외부 접속 열기…', visible: state.shareSupported === true, enabled: state.phase === 'ready' && !['opening', 'on'].includes(state.share) && !shareBusy, click: () => void openShare() },
      { label: '외부 접속 주소 복사', visible: state.share === 'on', click: copyShare },
      { label: '외부 접속 닫기', visible: ['opening', 'on'].includes(state.share), click: () => void host?.closeShare().catch(showError) },
    ] },
  ]));
}
async function switchMode() {
  const next = mode === 'shared' ? 'personal' : 'shared';
  const { response } = await dialog.showMessageBox(editor, { type: 'question', message: next === 'shared' ? '여러 사람과 함께 쓰기(공동 작업용)로 바꿀까요?' : '혼자 쓰기(개인용)로 바꿀까요?',
    detail: '앱을 다시 시작합니다. 두 방식의 문서와 설정은 따로 보관되며 지워지지 않습니다.', buttons: ['취소', '바꾸고 다시 시작'], defaultId: 1, cancelId: 0, noLink: true });
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
  mode = given || savedMode(app.getPath('userData'));
  if (!mode) {
    const choice = dialog.showMessageBoxSync({ type: 'question', title: 'Hwpx Cowork', message: MODE_CHOICE.message, detail: MODE_CHOICE.detail, buttons: MODE_CHOICE.buttons, defaultId: 0, cancelId: 0, noLink: true });
    mode = MODE_CHOICE.modes[choice] || 'personal';
    saveMode(app.getPath('userData'), mode);
  }
  const userdata = verificationAt < 0 && development && process.env.HWPX_DESKTOP_USERDATA ? path.resolve(process.env.HWPX_DESKTOP_USERDATA) : path.join(app.getPath('userData'), mode);
  host = new DesktopHost({ payload, node, userdata, mode });
  editor = new BrowserWindow({ title: mode === 'shared' ? 'Hwpx Cowork · 공동 작업' : 'Hwpx Cowork · 내 문서', width: 1440, height: 940, minWidth: 900, minHeight: 650, backgroundColor: '#f5f6f2', webPreferences: { preload: path.join(here, 'editor-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  guardWindow(editor); menus();
  // 웹 편집기의 beforeunload 저장 경고가 창 닫기를 막을 수 있게 서버 종료보다 먼저 닫기를 시도한다.
  editor.webContents.on('will-prevent-unload', createBlockedCloseHandler({
    confirmDiscard: () => dialog.showMessageBoxSync(editor, { type: 'warning',
      message: '저장되지 않은 변경 내용을 버리시겠습니까?',
      detail: '이미 자동 저장된 내용은 유지됩니다. 아직 저장되지 않은 변경 내용은 사라집니다.',
      buttons: ['취소', '변경 내용 버리기'], defaultId: 0, cancelId: 0, noLink: true,
    }) === 1,
  }));
  editor.on('closed', () => { editor = null; app.quit(); });
  let shown = '';
  host.on('state', state => {
    const key = `${state.phase}|${state.share}|${state.aiSupported}`; if (key !== shown) { shown = key; menus(); }
    if (settings && !settings.isDestroyed()) settings.webContents.send('desktop-state', state);
    if (state.phase === 'error') showError(new Error(state.message));
  });
  await editor.loadFile(path.join(here, 'loading.html'));
  try {
    const url = await host.start();
    if (quitting) return;
    await editor.loadURL(url);
    const ai = host.preferences().ai;
    if (ai !== 'none' && host.snapshot().aiSupported) void host.prepareAi(ai).catch(() => showAi());
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
ipcMain.handle('desktop-action', async (event, action, value) => {
  if (!settings || event.sender !== settings.webContents || event.senderFrame.url !== ownFile('ai.html')) throw new Error('지원하지 않는 요청입니다.');
  try {
    if (action === 'state') return host.snapshot();
    if (action === 'connect') await host.prepareAi(value);
    else if (action === 'disconnect') await host.disconnectAi();
    else if (action === 'close') settings.close();
    else throw new Error('지원하지 않는 요청입니다.');
    return { ok: true };
  } catch (error) { return { ok: false, message: error.message }; }
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
