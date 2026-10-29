const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const directoryWatchers = new Map();

function closeDirectoryWatcher(key) {
  const record = directoryWatchers.get(key);
  if (!record) return;
  clearTimeout(record.timer);
  record.watcher.close();
  directoryWatchers.delete(key);
}

function closeWindowWatchers(webContentsId) {
  for (const [key, record] of directoryWatchers) {
    if (record.webContentsId === webContentsId) closeDirectoryWatcher(key);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f6f8',
    title: 'Koa Kommander',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('destroyed', () => closeWindowWatchers(win.webContents.id));
}

function fileInfo(entry, parent) {
  const fullPath = path.join(parent, entry.name);
  return {
    name: entry.name,
    path: fullPath,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile()
  };
}

async function transferInfo(fullPath) {
  const stats = await fs.stat(fullPath);
  return {
    name: path.basename(fullPath),
    path: fullPath,
    isDirectory: stats.isDirectory(),
    size: stats.size,
    modified: stats.mtime.toISOString()
  };
}

ipcMain.handle('fs:roots', async () => {
  const roots = [];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        await fs.access(drive);
        roots.push({ name: drive, path: drive, isDirectory: true });
      } catch { /* Skip unavailable drives. */ }
    }
  } else {
    roots.push({ name: '/', path: '/', isDirectory: true });
  }
  return roots;
});

ipcMain.handle('dialog:choose-directory', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Choose a directory',
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('fs:watch-directory', (event, { side, directory }) => {
  if (side !== 'left' && side !== 'right') throw new Error('Invalid panel for directory watch.');
  const key = `${event.sender.id}:${side}`;
  closeDirectoryWatcher(key);
  const currentDirectory = path.resolve(directory);
  try {
    const watcher = watch(currentDirectory, { persistent: false }, () => {
      const record = directoryWatchers.get(key);
      if (!record || record.watcher !== watcher) return;
      clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        if (!record.webContents.isDestroyed()) {
          record.webContents.send('fs:directory-changed', { side, directory: currentDirectory });
        }
      }, 150);
    });
    watcher.on('error', () => {
      if (directoryWatchers.get(key)?.watcher === watcher) closeDirectoryWatcher(key);
    });
    directoryWatchers.set(key, { watcher, webContents: event.sender, webContentsId: event.sender.id, directory: currentDirectory, timer: null });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('fs:list', async (_event, directory) => {
  const current = path.resolve(directory || app.getPath('home'));
  const entries = await fs.readdir(current, { withFileTypes: true });
  const results = await Promise.all(entries.map(async (entry) => {
    const item = fileInfo(entry, current);
    try {
      const stats = await fs.stat(item.path);
      item.size = stats.size;
      item.modified = stats.mtime.toISOString();
      item.created = stats.birthtime.toISOString();
    } catch {
      item.size = 0;
      item.modified = null;
      item.created = null;
    }
    return item;
  }));
  results.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: current, parent: path.dirname(current), entries: results };
});

ipcMain.handle('fs:transfer', async (_event, { sources, destination, operation, conflictAction, renameTo }) => {
  const targetDirectory = path.resolve(destination);
  const results = [];
  for (const rawSource of sources) {
    const source = path.resolve(rawSource);
    if (source === targetDirectory || targetDirectory.startsWith(`${source}${path.sep}`)) {
      results.push({ source, ok: false, error: 'A folder cannot be copied or moved into itself.' });
      continue;
    }
    try {
      const sourceStats = await fs.stat(source);
      if (source === path.join(targetDirectory, path.basename(source))) {
        results.push({ source, ok: false, error: 'Source and destination are the same.' });
        continue;
      }
      let targetName = path.basename(source);
      if (conflictAction === 'rename') {
        targetName = String(renameTo || '').trim();
        if (!targetName || targetName === '.' || targetName === '..' || path.basename(targetName) !== targetName) {
          throw new Error('Enter a valid name for the incoming item.');
        }
      }
      const target = path.join(targetDirectory, targetName);
      if (source === target) {
        results.push({ source, ok: false, error: 'Source and destination are the same.' });
        continue;
      }
      let targetStats = null;
      try { targetStats = await fs.stat(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }

      if (targetStats && !conflictAction) {
        results.push({
          source, target, ok: false, conflict: true,
          sourceInfo: await transferInfo(source),
          targetInfo: await transferInfo(target)
        });
        continue;
      }
      if (conflictAction === 'cancel') {
        results.push({ source, target, ok: false, cancelled: true });
        continue;
      }

      if (targetStats && conflictAction === 'overwrite') {
        if (sourceStats.isDirectory() || targetStats.isDirectory()) {
          throw new Error('Only files can be overwritten. Choose Merge for two folders or Rename.');
        }
        await fs.copyFile(source, target);
        if (operation === 'move') await fs.rm(source, { force: false });
      } else if (targetStats && conflictAction === 'merge') {
        if (!sourceStats.isDirectory() || !targetStats.isDirectory()) {
          throw new Error('Only two folders can be merged. Choose Rename.');
        }
        await fs.cp(source, target, { recursive: true, force: true });
        if (operation === 'move') await fs.rm(source, { recursive: true, force: false });
      } else if (operation === 'move') {
        try {
          await fs.rename(source, target);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fs.cp(source, target, { recursive: true, errorOnExist: true });
          await fs.rm(source, { recursive: true, force: false });
        }
      } else {
        await fs.cp(source, target, { recursive: true, errorOnExist: true });
      }
      results.push({ source, target, ok: true });
    } catch (error) {
      results.push({ source, ok: false, error: error.message });
    }
  }
  return results;
});

ipcMain.handle('fs:delete', async (event, { entries, confirm }) => {
  const count = entries.length;
  const confirmation = confirm ? await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
    type: 'warning',
    title: 'Confirm deletion',
    message: count === 1 ? 'Delete this item?' : `Delete these ${count} items?`,
    detail: 'By default, items are moved to the Recycle Bin.',
    checkboxLabel: 'Permanently delete?',
    checkboxChecked: false,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }) : { response: 0, checkboxChecked: false };
  if (confirmation.response !== 0) return { cancelled: true, permanent: false, results: [] };

  const permanent = confirmation.checkboxChecked;
  const results = [];
  for (const item of entries) {
    try {
      if (permanent) await fs.rm(path.resolve(item), { recursive: true, force: false });
      else await shell.trashItem(path.resolve(item));
      results.push({ path: item, ok: true });
    } catch (error) {
      results.push({ path: item, ok: false, error: error.message });
    }
  }
  return { cancelled: false, permanent, results };
});
ipcMain.handle('fs:open', async (_event, itemPath) => {
  const resolved = path.resolve(itemPath);
  const stats = await fs.stat(resolved);
  if (stats.isDirectory()) return { navigateTo: resolved };
  const error = await shell.openPath(resolved);
  return { error };
});

ipcMain.handle('fs:show-in-explorer', async (_event, itemPath) => {
  shell.showItemInFolder(path.resolve(itemPath));
});

ipcMain.handle('fs:create-folder', async (_event, { parent, name }) => {
  const safeName = path.basename(name.trim());
  if (!safeName || safeName !== name.trim()) throw new Error('Enter a valid folder name.');
  const destination = path.join(path.resolve(parent), safeName);
  await fs.mkdir(destination);
  return destination;
});

ipcMain.handle('fs:rename', async (_event, { source: rawSource, name: rawName }) => {
  const source = path.resolve(rawSource);
  const name = String(rawName).trim();
  const safeName = path.basename(name);
  if (!name || name === '.' || name === '..' || safeName !== name) {
    throw new Error('Enter a valid file name.');
  }
  const destination = path.join(path.dirname(source), safeName);
  if (destination === source) return destination;
  try {
    await fs.lstat(destination);
    throw new Error(`“${safeName}” already exists in this folder.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.rename(source, destination);
  return destination;
});
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


