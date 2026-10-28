const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

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

ipcMain.handle('fs:transfer', async (_event, { sources, destination, operation }) => {
  const targetDirectory = path.resolve(destination);
  const results = [];
  for (const rawSource of sources) {
    const source = path.resolve(rawSource);
    if (source === targetDirectory || targetDirectory.startsWith(`${source}${path.sep}`)) {
      results.push({ source, ok: false, error: 'A folder cannot be copied or moved into itself.' });
      continue;
    }
    const target = path.join(targetDirectory, path.basename(source));
    try {
      try {
        await fs.lstat(target);
        throw new Error(`“${path.basename(target)}” already exists here.`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (operation === 'move') {
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

ipcMain.handle('fs:delete', async (_event, entries) => {
  const results = [];
  for (const item of entries) {
    try {
      await shell.trashItem(path.resolve(item));
      results.push({ path: item, ok: true });
    } catch (error) {
      results.push({ path: item, ok: false, error: error.message });
    }
  }
  return results;
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

