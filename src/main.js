const { app, BrowserWindow, ipcMain, shell, Menu, dialog, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { watch } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const directoryWatchers = new Map();
const maxThumbnailPixels = 192;
const thumbnailCachePrefix = 'koa-thumbnail-';

function getGitCommitCount() {
  try {
    const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^\d+$/.test(count) ? Number(count) : null;
  } catch {
    return null;
  }
}

function expandEnvironmentVariables(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/%([^%]+)%/g, (placeholder, name) => {
    let variable = process.env[name];
    if (variable === undefined && process.platform === 'win32') {
      const match = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
      if (match) variable = process.env[match];
    }
    return variable === undefined ? placeholder : variable;
  });
}

function resolvePath(value) {
  return path.resolve(expandEnvironmentVariables(value));
}

function thumbnailCacheDirectory(directory) {
  return typeof directory === 'string' && directory.trim()
    ? resolvePath(directory)
    : path.join(app.getPath('userData'), 'thumbnail-cache');
}

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

function readWindowState() {
  try {
    const statePath = path.join(app.getPath('userData'), 'window-state.json');
    const saved = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
    return {
      width: Number.isInteger(saved.width) && saved.width >= 900 ? saved.width : 1440,
      height: Number.isInteger(saved.height) && saved.height >= 600 ? saved.height : 900,
      maximized: saved.maximized === true
    };
  } catch {
    return { width: 1440, height: 900, maximized: false };
  }
}

function saveWindowState(win) {
  if (win.isDestroyed()) return;
  const { width, height } = win.getNormalBounds();
  const statePath = path.join(app.getPath('userData'), 'window-state.json');
  try {
    fsSync.mkdirSync(path.dirname(statePath), { recursive: true });
    fsSync.writeFileSync(statePath, JSON.stringify({ width, height, maximized: win.isMaximized() }));
  } catch (error) {
    console.error('Could not save window size:', error);
  }
}

ipcMain.handle('app:version-info', () => {
  const packageVersion = app.getVersion();
  const majorMinor = packageVersion.match(/^(\d+)\.(\d+)/);
  const commitCount = getGitCommitCount();
  const version = majorMinor && commitCount !== null
    ? `${majorMinor[1]}.${majorMinor[2]}.${commitCount}`
    : packageVersion;
  return { version, commitCount };
});

function createWindow() {
  const windowState = readWindowState();
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f4f6f8',
    icon: path.join(__dirname, 'assets', 'koa-studio-logo.ico'),
    title: 'Koa Kommander',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  let saveTimer;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 250);
  };
  win.on('resize', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveWindowState(win);
  });
  if (windowState.maximized) win.maximize();

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

ipcMain.handle('dialog:choose-directory', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Choose a directory',
    properties: ['openDirectory'],
    ...(typeof defaultPath === 'string' && defaultPath && fsSync.existsSync(defaultPath) ? { defaultPath } : {})
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('fs:watch-directory', (event, { side, directory }) => {
  if (side !== 'left' && side !== 'right') throw new Error('Invalid panel for directory watch.');
  const key = `${event.sender.id}:${side}`;
  closeDirectoryWatcher(key);
  const currentDirectory = resolvePath(directory);
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
  const current = resolvePath(directory || app.getPath('home'));
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

ipcMain.handle('settings:thumbnail-cache-default-path', () => thumbnailCacheDirectory());

ipcMain.handle('fs:clear-thumbnail-cache', async (_event, directory) => {
  const cacheDirectory = thumbnailCacheDirectory(directory);
  let entries;
  try { entries = await fs.readdir(cacheDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const cachedFiles = entries.filter((entry) => entry.isFile() && /^koa-thumbnail-[a-f0-9]{64}\.png$/i.test(entry.name));
  const results = await Promise.allSettled(cachedFiles.map((entry) => fs.unlink(path.join(cacheDirectory, entry.name))));
  return results.filter((result) => result.status === 'fulfilled').length;
});

ipcMain.handle('fs:thumbnail', async (_event, { itemPath, cachePath }) => {
  const fullPath = resolvePath(itemPath);
  const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic']);
  if (!imageExtensions.has(path.extname(fullPath).toLowerCase())) return null;
  try {
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) return null;
    const cacheDirectory = thumbnailCacheDirectory(cachePath);
    const cacheKey = crypto.createHash('sha256')
      .update(`${fullPath}\0${stats.size}\0${stats.mtimeMs}\0${maxThumbnailPixels}`)
      .digest('hex');
    const cacheFile = path.join(cacheDirectory, `${thumbnailCachePrefix}${cacheKey}.png`);
    try {
      const cachedPng = await fs.readFile(cacheFile);
      if (!nativeImage.createFromBuffer(cachedPng).isEmpty()) return `data:image/png;base64,${cachedPng.toString('base64')}`;
      await fs.unlink(cacheFile).catch(() => {});
    } catch { /* Generate a fresh thumbnail when the cache is missing or unreadable. */ }
    let image = nativeImage.createFromPath(fullPath);
    if (image.isEmpty()) {
      try {
        image = await nativeImage.createThumbnailFromPath(fullPath, { width: maxThumbnailPixels, height: maxThumbnailPixels });
      } catch {
        return null;
      }
    }
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (!width || !height) return null;
    const scale = Math.min(1, maxThumbnailPixels / Math.max(width, height));
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'best'
      });
    }
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    try {
      await fs.mkdir(cacheDirectory, { recursive: true });
      await fs.writeFile(cacheFile, png);
    } catch { /* Previews still work when the cache location is unavailable. */ }
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.handle('fs:disk-space', async (_event, directory) => {
  const stats = await fs.statfs(resolvePath(directory));
  const total = stats.blocks * stats.bsize;
  const free = (stats.bavail ?? stats.bfree) * stats.bsize;
  return { total, free, used: Math.max(0, total - free) };
});

ipcMain.handle('fs:transfer', async (_event, { sources, destination, operation, conflictAction, renameTo }) => {
  const targetDirectory = resolvePath(destination);
  const results = [];
  for (const rawSource of sources) {
    const source = resolvePath(rawSource);
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

ipcMain.handle('fs:create-shortcuts', async (_event, { sources, destination }) => {
  if (process.platform !== 'win32') return sources.map((source) => ({ source, ok: false, error: 'Windows shortcuts are only supported on Windows.' }));
  const targetDirectory = resolvePath(destination);
  const results = [];
  for (const rawSource of sources) {
    const source = resolvePath(rawSource);
    try {
      const sourceInfo = await transferInfo(source);
      const base = `${path.basename(source)} - Shortcut`;
      let name = `${base}.lnk`;
      let suffix = 2;
      while (true) {
        try { await fs.lstat(path.join(targetDirectory, name)); name = `${base} (${suffix++}).lnk`; }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
      const shortcutPath = path.join(targetDirectory, name);
      const created = shell.writeShortcutLink(shortcutPath, 'create', {
        target: source,
        description: `Shortcut to ${sourceInfo.name}`
      });
      if (!created) throw new Error('Windows could not create the shortcut.');
      results.push({ source, target: shortcutPath, ok: true });
    } catch (error) { results.push({ source, ok: false, error: error.message }); }
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
      if (permanent) await fs.rm(resolvePath(item), { recursive: true, force: false });
      else await shell.trashItem(resolvePath(item));
      results.push({ path: item, ok: true });
    } catch (error) {
      results.push({ path: item, ok: false, error: error.message });
    }
  }
  return { cancelled: false, permanent, results };
});
ipcMain.handle('fs:open', async (_event, itemPath) => {
  const resolved = resolvePath(itemPath);
  const stats = await fs.stat(resolved);
  if (stats.isDirectory()) return { navigateTo: resolved };
  const error = await shell.openPath(resolved);
  return { error };
});

ipcMain.handle('fs:show-in-explorer', async (_event, itemPath) => {
  shell.showItemInFolder(resolvePath(itemPath));
});

ipcMain.handle('fs:create-folder', async (_event, { parent, name }) => {
  const safeName = path.basename(name.trim());
  if (!safeName || safeName !== name.trim()) throw new Error('Enter a valid folder name.');
  const destination = path.join(resolvePath(parent), safeName);
  await fs.mkdir(destination);
  return destination;
});

ipcMain.handle('fs:rename', async (_event, { source: rawSource, name: rawName }) => {
  const source = resolvePath(rawSource);
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


