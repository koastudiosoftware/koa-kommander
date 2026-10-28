const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fileManager', {
  roots: () => ipcRenderer.invoke('fs:roots'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  list: (directory) => ipcRenderer.invoke('fs:list', directory),
  transfer: (request) => ipcRenderer.invoke('fs:transfer', request),
  delete: (request) => ipcRenderer.invoke('fs:delete', request),
  open: (itemPath) => ipcRenderer.invoke('fs:open', itemPath),
  showInExplorer: (itemPath) => ipcRenderer.invoke('fs:show-in-explorer', itemPath),
  createFolder: (request) => ipcRenderer.invoke('fs:create-folder', request),
  rename: (request) => ipcRenderer.invoke('fs:rename', request)
});

