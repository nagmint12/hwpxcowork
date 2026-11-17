const { contextBridge } = require('electron');
// Read-only host capability. Files and credentials remain behind the local server.
contextBridge.exposeInMainWorld('hwpxDesktopEnvironment', { automaticLocalFonts: true });
