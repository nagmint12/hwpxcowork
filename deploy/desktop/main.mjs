import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopHost } from './host.mjs';
import { desktopPermission } from './permissions.mjs';
import { createBlockedCloseHandler } from './close-policy.mjs';
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
let editor; let settings; let host; let quitting = false; let quittingNow = false;
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hwpx Cowork', submenu: [{ role: 'about', label: 'Hwpx Cowork 정보' }, { type: 'separator' }, { label: '내 AI 연결…', visible: aiSupported, click: showAi }, { type: 'separator', visible: aiSupported }, { role: 'hide', label: '가리기' }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [{ label: '문서 폴더 연결…', accelerator: 'CmdOrCtrl+Shift+O', click: connectFolder }, { type: 'separator' }, { role: 'close', label: '창 닫기' }] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'togglefullscreen', label: '전체 화면' }, { role: 'resetzoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }] },
    { label: 'AI', visible: aiSupported, submenu: [{ label: 'ChatGPT·Claude 연결…', click: showAi }, { label: 'AI 연결 끊기', click: () => void host?.disconnectAi().catch(showError) }] },
  ]));
}
function showError(error) { void dialog.showMessageBox(editor, { type: 'error', message: '작업을 마치지 못했습니다.', detail: error.message }); }
async function bootstrap() {
  const resources = process.resourcesPath;
  const development = !app.isPackaged;
  const payload = development && process.env.HWPX_DESKTOP_PAYLOAD ? path.resolve(process.env.HWPX_DESKTOP_PAYLOAD) : path.join(resources, 'payload', 'app');
  const node = development && process.env.HWPX_DESKTOP_NODE ? path.resolve(process.env.HWPX_DESKTOP_NODE) : path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const userdata = verificationAt < 0 && development && process.env.HWPX_DESKTOP_USERDATA ? path.resolve(process.env.HWPX_DESKTOP_USERDATA) : path.join(app.getPath('userData'), 'personal');
  host = new DesktopHost({ payload, node, userdata });
  editor = new BrowserWindow({ title: 'Hwpx Cowork · 내 문서', width: 1440, height: 940, minWidth: 900, minHeight: 650, backgroundColor: '#f5f6f2', webPreferences: { preload: path.join(here, 'editor-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
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
  host.on('state', state => {
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
