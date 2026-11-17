const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hwpxDesktop', {
  action: (action, value) => ipcRenderer.invoke('desktop-action', action, value),
  onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('desktop-state', handler); return () => ipcRenderer.removeListener('desktop-state', handler); },
});
