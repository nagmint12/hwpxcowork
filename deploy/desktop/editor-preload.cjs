const { contextBridge, ipcRenderer } = require('electron');
// Only the top-level Office Tabs page receives files or controls the save handshake.
const officePage = process.isMainFrame && location.protocol === 'http:' && location.hostname === 'localhost' && location.pathname === '/';
const environment = { automaticLocalFonts: true, portless: process.argv.includes('--hwpx-personal-stdio') };
if (officePage) {
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  environment.markOfficeTabsReady = () => ipcRenderer.send('office-tabs:ready');
  environment.finishClosing = (token, saved) => ipcRenderer.send('office-tabs:closed-preparation', token, saved === true);
  environment.finishOfficeFile = receipt => ipcRenderer.send('office-tabs:file-received', receipt);
  environment.pickOfficeFiles = () => ipcRenderer.send('office-tabs:pick-files');
  environment.openApplicationMenu = () => {
    const button = document.querySelector('[data-testid="office-app-menu"]');
    const rect = button?.getBoundingClientRect();
    ipcRenderer.send('office-tabs:application-menu', rect ? { x: rect.left, y: rect.bottom } : null);
  };
  ipcRenderer.on('office-tabs:command', (_event, command) => emit('hwpx-office-command', command));
  ipcRenderer.on('office-tabs:prepare-close', (_event, token) => emit('hwpx-office-prepare-close', token));
  ipcRenderer.on('office-tabs:cancel-close', (_event, token) => emit('hwpx-office-cancel-close', token));
  let current = null;
  ipcRenderer.on('office-tabs:file-start', (_event, { size, ...metadata }) => { current = { metadata, bytes: new Uint8Array(size), offset: 0 }; });
  ipcRenderer.on('office-tabs:file-chunk', (_event, bytes) => {
    if (current && current.offset + bytes.length <= current.bytes.length) {
      current.bytes.set(bytes, current.offset);
      current.offset += bytes.length;
    }
  });
  ipcRenderer.on('office-tabs:file-end', (_event, receipt) => {
    const file = current;
    current = null;
    if (receipt && file && file.offset === file.bytes.length) {
      emit('hwpx-office-files', [{ ...file.metadata, bytes: file.bytes, receipt }]);
    }
  });
}
contextBridge.exposeInMainWorld('hwpxDesktopEnvironment', environment);
if (location.protocol === 'file:' && location.pathname.endsWith('/server-console.html')) {
  contextBridge.exposeInMainWorld('hwpxServer', {
    action: name => ipcRenderer.invoke('server-console-action', name),
    onState: fn => { ipcRenderer.on('server-console-state', (_event, state) => fn(state)); },
  });
}
