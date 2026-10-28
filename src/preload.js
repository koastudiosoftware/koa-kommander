const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fileManager', {
  roots: () => ipcRenderer.invoke('fs:roots'),
  list: (directory) => ipcRenderer.invoke('fs:list', directory),
  transfer: (request) => ipcRenderer.invoke('fs:transfer', request),
  delete: (entries) => ipcRenderer.invoke('fs:delete', entries),
  open: (itemPath) => ipcRenderer.invoke('fs:open', itemPath),
  showInExplorer: (itemPath) => ipcRenderer.invoke('fs:show-in-explorer', itemPath),
  createFolder: (request) => ipcRenderer.invoke('fs:create-folder', request),
  rename: (request) => ipcRenderer.invoke('fs:rename', request)
});

