const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fileManager', {
  versionInfo: () => ipcRenderer.invoke('app:version-info'),
  roots: () => ipcRenderer.invoke('fs:roots'),
  watchDirectory: (side, directory) => ipcRenderer.invoke('fs:watch-directory', { side, directory }),
  onDirectoryChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('fs:directory-changed', listener);
    return () => ipcRenderer.removeListener('fs:directory-changed', listener);
  },
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('dialog:choose-directory', defaultPath),
  list: (directory) => ipcRenderer.invoke('fs:list', directory),
  thumbnail: (itemPath, cachePath) => ipcRenderer.invoke('fs:thumbnail', { itemPath, cachePath }),
  thumbnailCacheDefaultPath: () => ipcRenderer.invoke('settings:thumbnail-cache-default-path'),
  clearThumbnailCache: (cachePath) => ipcRenderer.invoke('fs:clear-thumbnail-cache', cachePath),
  diskSpace: (directory) => ipcRenderer.invoke('fs:disk-space', directory),
  transfer: (request) => ipcRenderer.invoke('fs:transfer', request),
  createShortcuts: (request) => ipcRenderer.invoke('fs:create-shortcuts', request),
  delete: (request) => ipcRenderer.invoke('fs:delete', request),
  open: (itemPath) => ipcRenderer.invoke('fs:open', itemPath),
  openInFileManager: (itemPath) => ipcRenderer.invoke('fs:open-in-file-manager', itemPath),
  createFolder: (request) => ipcRenderer.invoke('fs:create-folder', request),
  rename: (request) => ipcRenderer.invoke('fs:rename', request)
});

