const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hwpxLocal', {
  fonts: Object.freeze({ autoLoad: true }),
  open: () => ipcRenderer.invoke('local-file', 'open'),
  saveAs: options => ipcRenderer.invoke('local-file', 'save-as', options),
  read: id => ipcRenderer.invoke('local-file', 'read', { id }),
  write: (id, bytes) => ipcRenderer.invoke('local-file', 'write', { id, bytes }),
  same: (a, b) => ipcRenderer.invoke('local-file', 'same', { a, b }),
  dirty: value => ipcRenderer.send('local-dirty', value === true),
  ready: () => ipcRenderer.invoke('local-file', 'ready'),
  onOpen: callback => { const handler = (_event, descriptor) => callback(descriptor); ipcRenderer.on('local-open', handler); return () => ipcRenderer.removeListener('local-open', handler); },
  onCommand: callback => { const handler = (_event, id) => callback(String(id)); ipcRenderer.on('local-command', handler); return () => ipcRenderer.removeListener('local-command', handler); },
});
