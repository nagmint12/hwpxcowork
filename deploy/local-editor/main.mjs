import { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalFiles, assetPath } from './files.mjs';
import { localEditorPermission } from './permissions.mjs';
import { createCloseGuard } from './close-guard.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const START = 'hwpx-local://editor/assets/editor/index.html?renderer=canvas2d';
protocol.registerSchemesAsPrivileged([{ scheme: 'hwpx-local', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Hwpx Editor');
if (!app.isPackaged && process.env.HWPX_LOCAL_PROFILE) app.setPath('userData', path.resolve(process.env.HWPX_LOCAL_PROFILE));
const files = new LocalFiles();
let window; let dirty = false; let ready = false; let queued = null;
const own = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('hwpx-local://editor/assets/editor/index.html');
async function openExternal(file) {
  if (dirty) {
    const answer = await dialog.showMessageBox(window, { type: 'warning', message: '저장하지 않은 수정이 있습니다.', detail: '현재 문서를 먼저 저장한 뒤 다른 파일을 열어 주세요.', buttons: ['편집기로 돌아가기'] });
    return;
  }
  try { const descriptor = await files.grant(file); if (ready) window.webContents.send('local-open', descriptor); else queued = descriptor; }
  catch (error) { await dialog.showMessageBox({ type: 'error', message: '문서를 열지 못했습니다.', detail: error.message }); }
}
app.on('open-file', (event, file) => { event.preventDefault(); if (window) void openExternal(file); else queued = file; });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { window?.show(); window?.focus(); const file = argv.find(arg => /\.(hwp|hwpx|hml)$/i.test(arg)); if (file) void openExternal(file); });
  app.whenReady().then(async () => {
    const editor = !app.isPackaged && process.env.HWPX_LOCAL_ASSETS ? path.resolve(process.env.HWPX_LOCAL_ASSETS) : path.join(process.resourcesPath, 'editor');
    protocol.handle('hwpx-local', request => { try { return net.fetch(pathToFileURL(assetPath(editor, request.url)).href); } catch { return new Response('Not found', { status: 404 }); } });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(hwpx-local:|file:|blob:|data:|devtools:)/.test(details.url) }));
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => localEditorPermission(window?.webContents, contents, permission, origin, details));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(localEditorPermission(window?.webContents, contents, permission, details?.requestingUrl, details)));
    window = new BrowserWindow({ title: 'Hwpx Editor', width: 1440, height: 940, minWidth: 900, minHeight: 650, webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== START) event.preventDefault(); });
    window.on('close', createCloseGuard({
      isDirty: () => dirty,
      confirmDiscard: async () => (await dialog.showMessageBox(window, {
        type: 'warning', message: '변경 내용을 저장하지 않고 종료하시겠습니까?',
        detail: '저장하지 않은 변경 내용은 사라집니다.',
        buttons: ['취소', '저장하지 않고 종료'], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1,
      // Discard was confirmed above. Bypass the renderer's beforeunload guard,
      // which would otherwise veto the same close a second time.
      close: () => window?.destroy(),
    }));
    window.on('closed', () => { window = null; app.quit(); });
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
    const initial = queued; queued = null;
    await window.loadURL(START);
    if (typeof initial === 'string') await openExternal(initial);
  });
}
// 파일 메뉴는 편집기의 같은 명령(file:open 등)을 부른다. 단축키(⌘O·⌘S·⇧⌘S·⌘P)는 편집기가 직접 받으므로
// 메뉴에는 표시만 하고 등록하지 않는다(registerAccelerator:false — 같은 키로 두 번 실행되지 않게).
// ⌘M 은 편집기의 Ctrl+M 조합 키와 겹쳐 '최소화'에도 등록하지 않는다.
export const EDITOR_COMMANDS = Object.freeze(['file:new-doc', 'file:open', 'file:save', 'file:save-as', 'file:print']);
const command = (label, id, accelerator) => ({ label, id, ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
  click: () => { if (EDITOR_COMMANDS.includes(id) && window && !window.isDestroyed()) window.webContents.send('local-command', id); } });
export function menuTemplate() {
  return [
    { label: 'Hwpx Editor', submenu: [{ role: 'about', label: 'Hwpx Editor 정보' }, { type: 'separator' }, { role: 'services', label: '서비스' }, { type: 'separator' },
      { role: 'hide', label: 'Hwpx Editor 가리기' }, { role: 'hideOthers', label: '기타 가리기' }, { role: 'unhide', label: '모두 보기' }, { type: 'separator' }, { role: 'quit', label: 'Hwpx Editor 종료' }] },
    { label: '파일', submenu: [command('새 문서', 'file:new-doc'), command('열기…', 'file:open', 'CommandOrControl+O'), { type: 'separator' },
      command('저장', 'file:save', 'CommandOrControl+S'), command('다른 이름으로 저장…', 'file:save-as', 'CommandOrControl+Shift+S'), { type: 'separator' },
      command('인쇄…', 'file:print', 'CommandOrControl+P'), { type: 'separator' }, { role: 'close', label: '창 닫기' }] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'togglefullscreen', label: '전체 화면' }] },
    { label: '윈도우', submenu: [{ role: 'minimize', label: '최소화', registerAccelerator: false }, { role: 'zoom', label: '확대/축소' }, { type: 'separator' }, { role: 'front', label: '모두 앞으로 가져오기' }] },
  ];
}
ipcMain.on('local-dirty', (event, value) => { if (event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame) { dirty = value === true; window.setDocumentEdited(dirty); } });
ipcMain.handle('local-file', async (event, action, value = {}) => {
  if (!own(event)) throw new Error('지원하지 않는 파일 요청입니다.');
  if (action === 'ready') { ready = true; const pending = queued; queued = null; return pending; }
  if (action === 'read') return files.read(value.id);
  if (action === 'write') return files.write(value.id, value.bytes);
  if (action === 'same') return files.same(value.a, value.b);
  if (action === 'open') {
    const answer = await dialog.showOpenDialog(window, { title: '한글 문서 열기', properties: ['openFile'], filters: [{ name: '한글 문서', extensions: ['hwp', 'hwpx', 'hml'] }] });
    return answer.canceled ? null : files.grant(answer.filePaths[0]);
  }
  if (action === 'save-as') {
    const name = typeof value.name === 'string' ? path.basename(value.name) : '문서.hwpx';
    const ext = path.extname(name).slice(1).toLowerCase();
    const answer = await dialog.showSaveDialog(window, { title: '다른 이름으로 저장', defaultPath: name, filters: [{ name: '한글 문서', extensions: ['hwp', 'hwpx', 'hml'].includes(ext) ? [ext] : ['hwpx'] }] });
    return answer.canceled ? null : files.grant(answer.filePath, { creating: true });
  }
  throw new Error('지원하지 않는 파일 작업입니다.');
});
