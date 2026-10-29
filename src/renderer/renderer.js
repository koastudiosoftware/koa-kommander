let savedLayout = {};
try { savedLayout = JSON.parse(localStorage.getItem('koa-layout') || '{}') || {}; }
catch { savedLayout = {}; }
function restoreColumns(columns) {
  if (!Array.isArray(columns) || columns.length !== 3 || columns.some((width) => !Number.isFinite(width) || width <= 0)) return [58, 17, 25];
  const total = columns.reduce((sum, width) => sum + width, 0);
  return columns.map((width) => width / total * 100);
}
function restoreView(view) {
  return view === 'icons' ? 'icons' : 'details';
}
function restoreIconSize(size) {
  if (!Number.isFinite(size)) return 48;
  return Math.max(32, Math.min(160, 32 + Math.round((size - 32) / 8) * 8));
}
const panels = {
  left: { element: document.querySelector('#panel-left'), path: null, entries: [], selected: new Set(), view: restoreView(savedLayout.left?.view), iconSize: restoreIconSize(savedLayout.left?.iconSize), columns: restoreColumns(savedLayout.left?.columns), sortBy: 'name', sortDirection: 'asc', history: [], historyIndex: -1, watchPath: null },
  right: { element: document.querySelector('#panel-right'), path: null, entries: [], selected: new Set(), view: restoreView(savedLayout.right?.view), iconSize: restoreIconSize(savedLayout.right?.iconSize), columns: restoreColumns(savedLayout.right?.columns), sortBy: 'name', sortDirection: 'asc', history: [], historyIndex: -1, watchPath: null }
};
let layoutInitialized = false;
let activeSide = 'left';
let clipboard = null;
let toastTimer;
const defaultPreferences = { showHidden: false, groupFolders: true, confirmDelete: true, dateFormat: 'us', timeFormat: '12h', theme: 'system', directorySets: [], thumbnailCachePath: '' };
let preferences;
let savedPreferences = {};
try { savedPreferences = JSON.parse(localStorage.getItem('koa-settings') || '{}'); }
catch { savedPreferences = {}; }
preferences = { ...defaultPreferences, ...savedPreferences };
if (typeof preferences.thumbnailCachePath !== 'string') preferences.thumbnailCachePath = '';
if (!Array.isArray(savedPreferences.directorySets)) preferences.directorySets = (savedPreferences.bookmarks || []).map((directory) => ({ type: 'single', path: directory, openIn: 'active', name: '' }));
delete preferences.bookmarks;
const status = document.querySelector('#status-message');
const summary = document.querySelector('#drive-space-summary');
const menu = document.querySelector('#context-menu');
const historyMenu = document.querySelector('#history-menu');
const dropActionMenu = document.querySelector('#drop-action-menu');
const conflictBackdrop = document.querySelector('#conflict-backdrop');
const conflictItems = document.querySelector('#conflict-items');
const conflictActions = document.querySelector('#conflict-actions');
const conflictRename = document.querySelector('#conflict-rename');
const conflictRenameInput = document.querySelector('#conflict-rename-name');
const settingsBackdrop = document.querySelector('#settings-backdrop');
const settingsContent = document.querySelector('#settings-content');
let settingsCategory = 'files';
let defaultThumbnailCachePath = '';
let directorySetDraft = null;
let resolveConflictDecision = null;
let rightDragCandidate = null;
let pendingRightDrop = null;
let suppressRightContextUntil = 0;
let diskSpaceTimer = null;
let diskSpaceRequestId = 0;
let displayedSpacePath = null;
function persistLayout() {
  if (!layoutInitialized) return;
  try {
    localStorage.setItem('koa-layout', JSON.stringify({
      panelRatio,
      left: { path: panels.left.path, columns: panels.left.columns, view: panels.left.view, iconSize: panels.left.iconSize },
      right: { path: panels.right.path, columns: panels.right.columns, view: panels.right.view, iconSize: panels.right.iconSize }
    }));
  } catch { /* Keep the file manager usable when storage is unavailable. */ }
}
function persistPanelViews() {
  try {
    const layout = JSON.parse(localStorage.getItem('koa-layout') || '{}') || {};
    for (const side of ['left', 'right']) {
      layout[side] = { ...layout[side], view: panels[side].view, iconSize: panels[side].iconSize };
    }
    localStorage.setItem('koa-layout', JSON.stringify(layout));
  } catch { /* Keep the file manager usable when storage is unavailable. */ }
}

function savePreferences() {
  localStorage.setItem('koa-settings', JSON.stringify(preferences));
  document.documentElement.dataset.theme = preferences.theme;
}
savePreferences();

const icon = (name) => {
  const paths = {
    folder: '<path d="M2.5 6.5h5l2 2h10v9.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M2.5 8.5h17"/>',
    file: '<path d="M5 2.5h8l5 5v13H5a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 5 2.5Z"/><path d="M13 2.8v5h4.7M7 12h7M7 15h7"/>',
    image: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 3-4 5 6"/>',
    pdf: '<path d="M5 2.5h8l5 5v13H5a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 5 2.5Z"/><path d="M13 2.8v5h4.7M7 13h8M7 16h6"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    archive: '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
};

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']);
function isImageEntry(entry) {
  return !entry.isDirectory && imageExtensions.has(entry.name.split('.').pop().toLowerCase());
}
function kind(entry) {
  if (entry.isDirectory) return 'folder';
  const ext = entry.name.split('.').pop().toLowerCase();
  if (imageExtensions.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['js','ts','json','html','css','py','md','yaml','yml','sh','bat'].includes(ext)) return 'code';
  if (['zip','7z','rar','tar','gz'].includes(ext)) return 'archive';
  return 'file';
}
function formatSize(size, directory) {
  if (directory) return '—';
  if (!size) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const n = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** n).toFixed(n === 0 ? 0 : 1)} ${units[n]}`;
}
function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateText = {
    us: `${month}/${day}/${year}`,
    eu: `${day}/${month}/${year}`,
    'iso-dash': `${year}-${month}-${day}`,
    'iso-slash': `${year}/${month}/${day}`
  }[preferences.dateFormat] || `${month}/${day}/${year}`;
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  let timeText;
  if (preferences.timeFormat === '24h') timeText = `${hours}:${minutes}`;
  else if (preferences.timeFormat === '24h-padded') timeText = `${String(hours).padStart(2, '0')}:${minutes}`;
  else timeText = `${hours % 12 || 12}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
  return `${dateText} ${timeText}`;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
function pathParts(fullPath) {
  const parsedRoot = fullPath.match(/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+|\/)/)?.[0] || '';
  const rest = fullPath.slice(parsedRoot.length).split(/[\\/]/).filter(Boolean);
  let current = parsedRoot;
  const result = [{ label: parsedRoot || fullPath, path: parsedRoot || fullPath }];
  for (const part of rest) {
    current = current ? `${current.replace(/[\\/]$/, '')}${fullPath.includes('\\') ? '\\' : '/'}${part}` : part;
    result.push({ label: part, path: current });
  }
  return result;
}
function setStatus(message) { status.textContent = message; }
function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}

function suggestedCopyName(name) {
  const extensionAt = name.lastIndexOf('.');
  const hasExtension = extensionAt > 0;
  const stem = hasExtension ? name.slice(0, extensionAt) : name;
  const extension = hasExtension ? name.slice(extensionAt) : '';
  return `${stem} (1)${extension}`;
}
function conflictObjectCard(label, item, choice, actionLabel, primary = false) {
  const tag = choice ? 'button' : 'article';
  const attributes = choice ? `type="button" data-conflict-choice="${choice}"` : '';
  return `<${tag} class="conflict-object-choice ${primary ? 'primary' : ''}" ${attributes}><div class="conflict-object-heading">${label}</div><div class="conflict-object-name"><span class="file-icon ${kind(item)}">${icon(kind(item))}</span><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong></div><dl><div><dt>Type</dt><dd>${item.isDirectory ? 'Folder' : 'File'}</dd></div><div><dt>Size</dt><dd>${formatSize(item.size, item.isDirectory)}</dd></div><div><dt>Modified</dt><dd>${formatDate(item.modified)}</dd></div></dl><div class="conflict-object-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</div><div class="conflict-object-action">${actionLabel || 'Choose Rename below for this item type'}</div></${tag}>`;
}
function askTransferConflict(conflict) {
  return new Promise((resolve) => {
    resolveConflictDecision = resolve;
    const incoming = conflict.sourceInfo;
    const existing = conflict.targetInfo;
    const bothFiles = !incoming.isDirectory && !existing.isDirectory;
    const bothFolders = incoming.isDirectory && existing.isDirectory;
    const newChoice = bothFiles ? 'overwrite' : bothFolders ? 'merge' : null;
    const newAction = bothFiles ? 'Overwrite the existing file' : bothFolders ? 'Merge folders · matching files are replaced' : null;
    conflictItems.innerHTML = `${conflictObjectCard('New item', incoming, newChoice, newAction, Boolean(newChoice))}${conflictObjectCard('Old item', existing, 'skip', 'Keep the existing item')}`;
    conflictActions.innerHTML = '<button class="conflict-choice" data-conflict-choice="rename">Rename incoming item</button><button class="conflict-choice cancel" data-conflict-choice="cancel">Cancel operation</button>';
    conflictRename.hidden = true;
    const candidate = suggestedCopyName(pathParts(conflict.target).at(-1)?.label || incoming.name);
    conflictRenameInput.value = candidate;
    conflictBackdrop.hidden = false;
    (conflictItems.querySelector('.primary') || conflictItems.querySelector('[data-conflict-choice]') || conflictActions.querySelector('[data-conflict-choice="rename"]'))?.focus();
  });
}
function finishConflictDecision(decision) {
  if (!resolveConflictDecision) return;
  const resolve = resolveConflictDecision;
  resolveConflictDecision = null;
  conflictBackdrop.hidden = true;
  resolve(decision);
}
conflictItems.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-conflict-choice]')?.dataset.conflictChoice;
  if (choice) finishConflictDecision({ choice });
});
conflictActions.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-conflict-choice]')?.dataset.conflictChoice;
  if (!choice) return;
  if (choice === 'rename') {
    conflictRename.hidden = false;
    conflictRenameInput.focus();
    conflictRenameInput.select();
    return;
  }
  finishConflictDecision({ choice });
});
document.querySelector('[data-conflict-confirm-rename]').addEventListener('click', () => {
  const name = conflictRenameInput.value.trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) { toast('Enter a valid file name'); return; }
  finishConflictDecision({ choice: 'rename', name });
});
conflictRenameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    document.querySelector('[data-conflict-confirm-rename]').click();
  }
});

async function navigate(side, directory, { historyMode = 'push', historyIndex = -1 } = {}) {
  const panel = panels[side];
  setStatus('Loading folder…');
  try {
    const result = await window.fileManager.list(directory);
    panel.path = result.path;
    panel.entries = result.entries;
    if (panel.watchPath !== result.path) {
      const watchedPath = result.path;
      panel.watchPath = watchedPath;
      window.fileManager.watchDirectory(side, watchedPath).then((watchResult) => {
        if (!watchResult.ok && panel.watchPath === watchedPath) panel.watchPath = null;
      }).catch(() => { if (panel.watchPath === watchedPath) panel.watchPath = null; });
    }
    if (historyMode === 'move') panel.historyIndex = historyIndex;
    else if (historyMode === 'push' && panel.history.at(-1) !== result.path) {
      panel.history = panel.history.slice(0, panel.historyIndex + 1);
      panel.history.push(result.path);
      panel.historyIndex = panel.history.length - 1;
    } else if (historyMode === 'push' && panel.historyIndex < 0) {
      panel.history = [result.path];
      panel.historyIndex = 0;
    }
    panel.selected.clear();
    renderPanel(side);
    persistLayout();
    setStatus('Ready');
    return true;
  } catch (error) {
    toast(`Could not open folder: ${error.message}`);
    setStatus('Could not load folder');
    return false;
  }
}

function panelChrome(side) {
  const panel = panels[side];
  const parts = panel.path ? pathParts(panel.path) : [];
  const crumbs = parts.map((part, index) => `<span class="crumb" data-crumb="${index}">${escapeHtml(part.label)}</span>${index < parts.length - 1 ? '<span class="crumb-sep">›</span>' : ''}`).join('');
  return `<div class="panel-top">
    <div class="pathbar"><button class="path-home" data-action="drives" title="Choose a drive">⌂</button>${crumbs}</div>
  </div>
  <div class="toolbar"><button class="toolbar-button icon-only" data-action="up" aria-label="Go up one folder" title="Go up one folder">${actionIcon('up')}</button><button class="toolbar-button icon-only" data-action="refresh" aria-label="Refresh" title="Refresh">${actionIcon('refresh')}</button><span class="toolbar-spacer"></span>
    <div class="view-group" role="group" aria-label="Panel view"><button class="view-button ${panel.view === 'details' ? 'active' : ''}" data-view="details" title="Details" aria-label="Details view" aria-pressed="${panel.view === 'details'}">${gridIcon('details')}</button><button class="view-button ${panel.view === 'icons' ? 'active' : ''}" data-view="icons" title="Thumbnails" aria-label="Thumbnail view" aria-pressed="${panel.view === 'icons'}">${gridIcon('icons')}</button></div>
    <button class="toolbar-button icon-only" data-action="match-other" aria-label="${side === 'left' ? 'Match right panel folder' : 'Match left panel folder'}" title="${side === 'left' ? 'Go to right panel folder' : 'Go to left panel folder'}">${actionIcon(side === 'left' ? 'left' : 'right')}</button>
    ${panel.view === 'icons' ? `<label class="size-control" title="Thumbnail size"><span data-size-value>${panel.iconSize}</span><input type="range" min="32" max="160" step="8" value="${panel.iconSize}" data-action="icon-size" aria-label="Thumbnail size"></label>` : ''}
  </div>`;
}
function editPanelPath(side) {
  const panel = panels[side];
  const pathbar = panel.element.querySelector('.pathbar');
  if (!pathbar || pathbar.querySelector('.path-edit-input')) return;
  pathbar.innerHTML = `<input class="path-edit-input" type="text" aria-label="Current folder path" spellcheck="false" value="${escapeHtml(panel.path || '')}">`;
  pathbar.classList.remove('is-invalid');
  const input = pathbar.querySelector('.path-edit-input');
  let submitting = false;
  input.focus();
  input.select();
  input.addEventListener('input', () => {
    pathbar.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      renderPanel(side);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const directory = input.value.trim();
      if (!directory) {
        pathbar.classList.add('is-invalid');
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      submitting = true;
      const opened = await navigate(side, directory);
      submitting = false;
      if (!opened && input.isConnected) {
        pathbar.classList.add('is-invalid');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    }
  });
  input.addEventListener('blur', () => {
    if (!submitting && input.isConnected && !pathbar.classList.contains('is-invalid')) renderPanel(side);
  });
}
function gridIcon(type) {
  return type === 'details'
    ? '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><path d="M5 3v2M5 7v2M5 11v2"/></svg>'
    : '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/></svg>';
}

function actionIcon(name) {
  const icons = {
    'new-folder': '<path d="M3 6.5h7l2 2h9v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 11v6M9 14h6"/>',    up: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
    refresh: '<path d="M4.5 9A8 8 0 0 1 18 5.5L20 9"/><path d="M20 9l-4.5-.3M20 9l-.4-4.5"/><path d="M19.5 15A8 8 0 0 1 6 18.5L4 15"/><path d="M4 15l4.5.3M4 15l.4 4.5"/>',
    left: '<path d="M12 19l-7-7 7-7"/>',
    right: '<path d="m12 5 7 7-7 7"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    cut: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="m8 7 12 12M8 17 20 5"/>',
    paste: '<path d="M9 4.5h6a2 2 0 0 1 2 2V8H7V6.5a2 2 0 0 1 2-2Z"/><path d="M7 6H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2M7 8h10M15 15h7M18.5 11.5v7"/>',
    rename: '<path d="M12 20h9"/><path d="m16.5 3.5 4 4L9 19l-5 1 1-5Z"/>',
    delete: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}
function entryAttributes(entry, side, index, tile = false) {
  const cls = kind(entry);
  const selected = panels[side].selected.has(entry.path);
  return `${tile ? 'class="icon-tile' : 'class="file-row'} ${selected ? 'selected' : ''}" data-entry="${index}" draggable="true" tabindex="0"`;
}
function renderEntries(side) {
  const panel = panels[side];
  if (panel.view === 'details') {
    const visibleEntries = panel.entries.filter((entry) => preferences.showHidden || !entry.name.startsWith('.'));
    const sortedEntries = [...visibleEntries].sort((a, b) => {
      let comparison = 0;
      if (preferences.groupFolders && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (panel.sortBy === 'name') comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      else if (panel.sortBy === 'size') comparison = (a.size || 0) - (b.size || 0);
      else comparison = new Date(a.modified || 0).getTime() - new Date(b.modified || 0).getTime();
      return comparison * (panel.sortDirection === 'asc' ? 1 : -1);
    });
    const rows = sortedEntries.map((entry) => {
      const index = panel.entries.indexOf(entry);
      return `<tr ${entryAttributes(entry, side, index)}><td><div class="name-cell"><span class="file-icon ${kind(entry)}">${icon(kind(entry))}</span><span class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span></div></td><td>${formatSize(entry.size, entry.isDirectory)}</td><td class="date-cell">${formatDate(entry.modified)}</td></tr>`;
    }).join('');
    const colgroup = panel.columns.map((width) => `<col style="width:${width}%">`).join('');
    const heading = (key, label, boundary = null) => `<th><button class="column-sort" data-sort="${key}">${label}${panel.sortBy === key ? `<span class="sort-arrow" aria-label="sorted ${panel.sortDirection === 'asc' ? 'ascending' : 'descending'}">${panel.sortDirection === 'asc' ? '▲' : '▼'}</span>` : ''}</button>${boundary === null ? '' : `<span class="column-grip" data-column-boundary="${boundary}" title="Resize ${label} column" aria-label="Resize ${label} column"></span>`}</th>`;
    const emptyState = visibleEntries.length ? '' : `<div class="empty-state">${icon('folder')}<strong>${panel.entries.length ? 'No visible items' : 'This folder is empty'}</strong><span>${panel.entries.length ? 'Hidden items are not shown' : 'Drop files here to add them'}</span></div>`;
    return `<div class="file-area"><table class="file-list" style="--name-width:${panel.columns[0]}%;--size-width:${panel.columns[1]}%;--date-width:${panel.columns[2]}%"><colgroup>${colgroup}</colgroup><thead><tr>${heading('name', 'Name', 0)}${heading('size', 'Size', 1)}${heading('modified', 'Date modified')}</tr></thead><tbody>${rows}</tbody></table>${emptyState}</div>`;
  }
  const tileSize = panel.iconSize + 48;
  const visibleEntries = panel.entries.filter((entry) => preferences.showHidden || !entry.name.startsWith('.'));
  const orderedEntries = [...visibleEntries].sort((a, b) => {
    if (preferences.groupFolders && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const tiles = orderedEntries.map((entry) => `<div ${entryAttributes(entry, side, panel.entries.indexOf(entry), true)} style="width:${tileSize}px;height:${tileSize}px"><div class="tile-visual ${kind(entry)}" style="width:${panel.iconSize}px;height:${panel.iconSize}px">${icon(kind(entry))}</div><div class="tile-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div></div>`).join('');
  return `<div class="file-area"><div class="icon-grid" style="--tile-width:${tileSize}px">${tiles}</div>${visibleEntries.length ? '' : '<div class="empty-state">'+icon('folder')+'<strong>This folder is empty</strong><span>Drop files here to add them</span></div>'}</div>`;
}
function renderPanel(side) {
  const panel = panels[side];
  panel.element.classList.toggle('is-active', activeSide === side);
  panel.element.innerHTML = `${panelChrome(side)}${renderEntries(side)}<div class="panel-bottom">${panelStatus(panel)}</div>`;
  if (panel.view === 'icons') {
    applyThumbnailSize(panel);
    loadThumbnailImages(side);
  }
  bindPanel(side);
  updateSummary();
}
function applyThumbnailSize(panel) {
  const grid = panel.element.querySelector('.icon-grid');
  if (!grid) return;
  const tileSize = panel.iconSize + 48;
  grid.style.setProperty('--tile-width', `${tileSize}px`);
  grid.querySelectorAll('.icon-tile').forEach((tile) => {
    tile.style.width = `${tileSize}px`;
    tile.style.height = `${tileSize}px`;
  });
  grid.querySelectorAll('.tile-visual').forEach((visual) => {
    visual.style.width = `${panel.iconSize}px`;
    visual.style.height = `${panel.iconSize}px`;
    const svg = visual.querySelector('svg');
    svg?.style.setProperty('width', `${panel.iconSize}px`, 'important');
    svg?.style.setProperty('height', `${panel.iconSize}px`, 'important');
  });
}
async function loadThumbnailImages(side) {
  const panel = panels[side];
  const tiles = [...panel.element.querySelectorAll('.icon-tile')].filter((tile) => {
    const entry = panel.entries[Number(tile.dataset.entry)];
    return entry && isImageEntry(entry);
  });
  let nextIndex = 0;
  const loadNext = async () => {
    while (nextIndex < tiles.length) {
      const tile = tiles[nextIndex++];
      const entry = panel.entries[Number(tile.dataset.entry)];
      if (!entry) continue;
      try {
        const dataUrl = await window.fileManager.thumbnail(entry.path, preferences.thumbnailCachePath);
        const visual = tile.querySelector('.tile-visual');
        if (!dataUrl || !visual?.isConnected || !tile.isConnected) continue;
        const thumbnail = document.createElement('img');
        thumbnail.className = 'thumbnail-image';
        thumbnail.alt = '';
        thumbnail.src = dataUrl;
        visual.replaceChildren(thumbnail);
      } catch { /* Keep the file type icon when a preview cannot be created. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, tiles.length) }, loadNext));
}
function updateSummary() {
  updateHistoryButtons();
  const directory = panels[activeSide].path;
  const requestId = ++diskSpaceRequestId;
  clearTimeout(diskSpaceTimer);
  if (!directory) {
    summary.textContent = 'Drive space unavailable';
    displayedSpacePath = null;
    return;
  }
  if (displayedSpacePath !== directory) summary.textContent = 'Reading drive space…';
  diskSpaceTimer = setTimeout(async () => {
    try {
      const space = await window.fileManager.diskSpace(directory);
      if (requestId !== diskSpaceRequestId || panels[activeSide].path !== directory) return;
      summary.textContent = `Used ${formatSize(space.used, false)} · Free ${formatSize(space.free, false)}`;
      displayedSpacePath = directory;
    } catch {
      if (requestId !== diskSpaceRequestId || panels[activeSide].path !== directory) return;
      summary.textContent = 'Drive space unavailable';
      displayedSpacePath = directory;
    }
  }, 120);
}
function panelStatus(panel) {
  const selectedCount = panel.selected.size;
  const selectedFiles = panel.entries.filter((entry) => panel.selected.has(entry.path) && !entry.isDirectory);
  const fileBytes = selectedFiles.reduce((sum, entry) => sum + (entry.size || 0), 0);
  return `<strong>${selectedCount || panel.entries.length}</strong>&nbsp;${selectedCount ? 'selected' : 'items'}<span class="bottom-spacer"></span>${selectedCount && selectedFiles.length ? `<span class="panel-selection-size">${formatSize(fileBytes, false)}</span>` : ''}`;
}
function updateHistoryButtons() {
  const panel = panels[activeSide];
  const back = document.querySelector('[data-action="back"]');
  const forward = document.querySelector('[data-action="forward"]');
  back.disabled = panel.historyIndex <= 0;
  forward.disabled = panel.historyIndex < 0 || panel.historyIndex >= panel.history.length - 1;
}
function moveHistory(side, offset) {
  const panel = panels[side];
  const targetIndex = panel.historyIndex + offset;
  if (targetIndex < 0 || targetIndex >= panel.history.length) return;
  moveHistoryTo(side, targetIndex);
}
function moveHistoryTo(side, targetIndex) {
  const panel = panels[side];
  if (targetIndex < 0 || targetIndex >= panel.history.length || targetIndex === panel.historyIndex) return;
  navigate(side, panel.history[targetIndex], { historyMode: 'move', historyIndex: targetIndex });
}
function showHistoryMenu(action, button) {
  const panel = panels[activeSide];
  const indices = action === 'back'
    ? Array.from({ length: Math.max(0, panel.historyIndex) }, (_, index) => panel.historyIndex - index - 1)
    : Array.from({ length: Math.max(0, panel.history.length - panel.historyIndex - 1) }, (_, index) => panel.historyIndex + index + 1);
  if (!indices.length) return;
  const side = activeSide;
  historyMenu.innerHTML = indices.map((index) => {
    const directory = panel.history[index];
    return `<button role="menuitem" data-history-side="${side}" data-history-index="${index}" title="${escapeHtml(directory)}">${escapeHtml(directory)}</button>`;
  }).join('');
  const bounds = button.getBoundingClientRect();
  historyMenu.hidden = false;
  historyMenu.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 330))}px`;
  historyMenu.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, innerHeight - Math.min(historyMenu.scrollHeight, 334) - 8))}px`;
}
function bindHistoryLongPress() {
  document.querySelectorAll('[data-action="back"],[data-action="forward"]').forEach((button) => {
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || button.disabled) return;
      startX = event.clientX;
      startY = event.clientY;
      button.setPointerCapture(event.pointerId);
      holdTimer = setTimeout(() => {
        showHistoryMenu(button.dataset.action, button);
        button.dataset.historyLongPress = 'true';
      }, 450);
    });
    const clearHold = () => { clearTimeout(holdTimer); holdTimer = null; };
    button.addEventListener('pointermove', (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) clearHold();
    });
    button.addEventListener('pointerup', clearHold);
    button.addEventListener('pointercancel', clearHold);
    button.addEventListener('click', (event) => {
      if (button.dataset.historyLongPress === 'true') {
        delete button.dataset.historyLongPress;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    });
  });
  historyMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-history-index]');
    if (!item) return;
    historyMenu.hidden = true;
    moveHistoryTo(item.dataset.historySide, Number(item.dataset.historyIndex));
  });
  document.addEventListener('mousedown', (event) => {
    if (!historyMenu.contains(event.target)) historyMenu.hidden = true;
  });
}
bindHistoryLongPress();
window.fileManager.onDirectoryChanged(({ side, directory }) => {
  const panel = panels[side];
  if (!panel || panel.path !== directory) return;
  window.fileManager.list(directory).then((result) => {
    if (panel.path !== directory) return;
    panel.entries = result.entries;
    const availablePaths = new Set(result.entries.map((entry) => entry.path));
    for (const selectedPath of panel.selected) {
      if (!availablePaths.has(selectedPath)) panel.selected.delete(selectedPath);
    }
    renderPanel(side);
  }).catch(() => {});
});
document.addEventListener('auxclick', (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  event.stopPropagation();
  moveHistory(activeSide, event.button === 3 ? -1 : 1);
});
function directorySetLabel(set) {
  if (set.name?.trim()) return set.name.trim();
  if (set.type === 'pair') return `${bookmarkLabel(set.leftPath)} ↔ ${bookmarkLabel(set.rightPath)}`;
  return bookmarkLabel(set.path);
}
function bookmarkLabel(directory = '') {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
}
function renderDirectorySets() {
  if (directorySetDraft) {
    const draft = directorySetDraft;
    const isPair = draft.type === 'pair';
    settingsContent.innerHTML = `<h2>${draft.index === null ? 'New directory set' : 'Edit directory set'}</h2><p class="settings-description">Save one location or a left/right directory pair.</p><label class="directory-set-field"><span>Name <small>(optional)</small></span><input data-set-field="name" value="${escapeHtml(draft.name || '')}" placeholder="For example, Project files"></label><label class="directory-set-field"><span>Set type</span><select data-set-field="type"><option value="single" ${!isPair ? 'selected' : ''}>Single directory</option><option value="pair" ${isPair ? 'selected' : ''}>Directory pair</option></select></label>${isPair ? `<div class="directory-set-field"><span>Left panel directory</span><div class="directory-path-input"><input data-set-field="leftPath" value="${escapeHtml(draft.leftPath || '')}" placeholder="Choose a folder"><button data-browse-field="leftPath">Browse…</button><button data-use-panel="left" title="Use current left panel folder">Use left</button></div></div><div class="directory-set-field"><span>Right panel directory</span><div class="directory-path-input"><input data-set-field="rightPath" value="${escapeHtml(draft.rightPath || '')}" placeholder="Choose a folder"><button data-browse-field="rightPath">Browse…</button><button data-use-panel="right" title="Use current right panel folder">Use right</button></div></div><p class="settings-hint">Opening a pair places its left and right directories in their matching panels.</p>` : `<div class="directory-set-field"><span>Directory</span><div class="directory-path-input"><input data-set-field="path" value="${escapeHtml(draft.path || '')}" placeholder="Choose a folder"><button data-browse-field="path">Browse…</button><button data-use-panel="left" title="Use current left panel folder">Use left</button><button data-use-panel="right" title="Use current right panel folder">Use right</button></div></div><label class="directory-set-field"><span>Open in panel</span><select data-set-field="openIn"><option value="active" ${draft.openIn === 'active' ? 'selected' : ''}>Active panel</option><option value="left" ${draft.openIn === 'left' ? 'selected' : ''}>Left panel</option><option value="right" ${draft.openIn === 'right' ? 'selected' : ''}>Right panel</option></select></label>`}<div class="directory-set-form-actions"><button class="settings-secondary" data-cancel-set>Back</button><button class="settings-primary" data-save-set>Save directory set</button></div>`;
    return;
  }
  const items = preferences.directorySets.map((set, index) => {
    const description = set.type === 'pair'
      ? `Left: ${set.leftPath} · Right: ${set.rightPath}`
      : `${set.path} · Opens in ${set.openIn === 'active' ? 'active panel' : `${set.openIn} panel`}`;
    return `<div class="directory-set-row"><div class="directory-set-summary"><strong>${escapeHtml(directorySetLabel(set))}</strong><small>${escapeHtml(description)}</small></div><button class="directory-set-open" data-open-set="${index}">Open</button><button class="bookmark-remove" data-edit-set="${index}" aria-label="Edit directory set" title="Edit">✎</button><button class="bookmark-remove" data-remove-set="${index}" aria-label="Remove directory set" title="Remove">×</button></div>`;
  }).join('');
  settingsContent.innerHTML = `<h2>Directory Sets</h2><p class="settings-description">Save a single location or a left/right pair, then open it in your preferred panel arrangement.</p><button class="settings-primary" data-new-set>New directory set</button><div class="directory-set-list">${items || '<p class="settings-empty">No directory sets yet.</p>'}</div>`;
}
function renderSettingsCategory() {
  document.querySelectorAll('.settings-category').forEach((button) => button.classList.toggle('active', button.dataset.category === settingsCategory));
  if (settingsCategory === 'files') {
    settingsContent.innerHTML = `<h2>Files &amp; Folders</h2><p class="settings-description">Choose which items appear and how they are arranged.</p><label class="setting-option"><span><strong>Show hidden files</strong><small>Include dot-prefixed files and folders in the panels.</small></span><input type="checkbox" data-preference="showHidden" ${preferences.showHidden ? 'checked' : ''}></label><label class="setting-option"><span><strong>Group folders before files</strong><small>Keep folders at the top of each panel.</small></span><input type="checkbox" data-preference="groupFolders" ${preferences.groupFolders ? 'checked' : ''}></label><label class="setting-option"><span><strong>Confirm before deleting</strong><small>When confirmation is disabled, items are moved to the Recycle Bin without a prompt.</small></span><input type="checkbox" data-preference="confirmDelete" ${preferences.confirmDelete ? 'checked' : ''}></label>`;
  } else if (settingsCategory === 'date-time') {
    settingsContent.innerHTML = `<h2>Date &amp; Time</h2><p class="settings-description">Choose how modification dates and times appear in the panels.</p><label class="setting-field"><span>Date format</span><select data-preference="dateFormat"><option value="us" ${preferences.dateFormat === 'us' ? 'selected' : ''}>MM/DD/YYYY (American)</option><option value="eu" ${preferences.dateFormat === 'eu' ? 'selected' : ''}>DD/MM/YYYY (European)</option><option value="iso-dash" ${preferences.dateFormat === 'iso-dash' ? 'selected' : ''}>YYYY-MM-DD</option><option value="iso-slash" ${preferences.dateFormat === 'iso-slash' ? 'selected' : ''}>YYYY/MM/DD</option></select></label><label class="setting-field date-time-field"><span>Time format</span><select data-preference="timeFormat"><option value="12h" ${preferences.timeFormat === '12h' ? 'selected' : ''}>12-hour with AM/PM</option><option value="24h" ${preferences.timeFormat === '24h' ? 'selected' : ''}>24-hour, no leading zero</option><option value="24h-padded" ${preferences.timeFormat === '24h-padded' ? 'selected' : ''}>24-hour, leading zero</option></select></label>`;
  } else if (settingsCategory === 'theme') {
    settingsContent.innerHTML = `<h2>Theme</h2><p class="settings-description">Choose the appearance used by the file manager.</p><label class="setting-field"><span>Color theme</span><select data-preference="theme"><option value="system" ${preferences.theme === 'system' ? 'selected' : ''}>System</option><option value="light" ${preferences.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${preferences.theme === 'dark' ? 'selected' : ''}>Dark</option></select></label>`;
  } else if (settingsCategory === 'thumbnails') {
    settingsContent.innerHTML = `<h2>Thumbnails</h2><p class="settings-description">Choose where generated image previews are stored, or clear the saved previews.</p><div class="thumbnail-cache-field"><label for="thumbnail-cache-path">Cache folder</label><div class="directory-path-input"><input id="thumbnail-cache-path" data-preference="thumbnailCachePath" value="${escapeHtml(preferences.thumbnailCachePath)}" placeholder="Default location"><button data-cache-browse>Browse…</button></div><p class="settings-hint">Leave blank to use the default cache folder: <span id="thumbnail-cache-default-path">Loading…</span></p></div><div class="thumbnail-cache-actions"><button class="settings-secondary" data-cache-default>Use default folder</button><button class="settings-primary" data-clear-thumbnail-cache>Clear thumbnail cache</button></div><p class="settings-hint" id="thumbnail-cache-status" role="status"></p>`;
    window.fileManager.thumbnailCacheDefaultPath().then((directory) => {
      defaultThumbnailCachePath = directory;
      const label = settingsContent.querySelector('#thumbnail-cache-default-path');
      if (label && settingsCategory === 'thumbnails') label.textContent = directory;
    }).catch(() => {
      const label = settingsContent.querySelector('#thumbnail-cache-default-path');
      if (label && settingsCategory === 'thumbnails') label.textContent = 'Unavailable';
    });
  } else if (settingsCategory === 'directory-sets') renderDirectorySets();
}
function openSettings() {
  settingsCategory = 'files';
  renderSettingsCategory();
  settingsBackdrop.hidden = false;
  document.querySelector('#settings-close').focus();
}
function closeSettings() {
  settingsBackdrop.hidden = true;
  document.querySelector('#settings-button').focus();
}
function getSelected(side) {
  const panel = panels[side];
  return panel.entries.filter((entry) => panel.selected.has(entry.path));
}
function refreshSelection() {
  document.querySelectorAll('.panel').forEach((panelElement) => {
    const side = panelElement.dataset.panel;
    const panel = panels[side];
    panelElement.classList.toggle('is-active', side === activeSide);
    panelElement.querySelectorAll('[data-entry]').forEach((item) => {
      const entry = panel.entries[Number(item.dataset.entry)];
      item.classList.toggle('selected', panel.selected.has(entry.path));
    });
    const bottom = panelElement.querySelector('.panel-bottom');
    if (bottom) bottom.innerHTML = panelStatus(panel);
  });
  updateSummary();
}
async function createFolder(side) {
  const parent = panels[side].path;
  const name = window.prompt('Name the new folder:');
  if (!name) return;
  try {
    await window.fileManager.createFolder({ parent, name });
    await navigate(side, parent);
  } catch (error) {
    toast(error.message);
  }
}

function bindPanel(side) {
  const panel = panels[side];
  const element = panel.element;
  element.querySelector('.pathbar')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) editPanelPath(side);
  });
  element.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (panel.view === view) return;
    panel.view = view;
    activeSide = side;
    renderPanel(side);
    persistPanelViews();
    persistLayout();
  }));
  const sizeSlider = element.querySelector('[data-action="icon-size"]');
  sizeSlider?.addEventListener('input', () => {
    panel.iconSize = Number(sizeSlider.value);
    element.querySelector('[data-size-value]').textContent = String(panel.iconSize);
    applyThumbnailSize(panel);
    persistPanelViews();
    persistLayout();
  });
  element.querySelectorAll('[data-crumb]').forEach((crumb) => crumb.addEventListener('click', () => {
    const part = pathParts(panel.path)[Number(crumb.dataset.crumb)];
    if (part) navigate(side, part.path);
  }));
  element.querySelectorAll('[data-sort]').forEach((heading) => heading.addEventListener('click', () => {
    const column = heading.dataset.sort;
    if (panel.sortBy === column) panel.sortDirection = panel.sortDirection === 'asc' ? 'desc' : 'asc';
    else { panel.sortBy = column; panel.sortDirection = 'asc'; }
    renderPanel(side);
  }));
  element.querySelectorAll('[data-column-boundary]').forEach((grip) => {
    let startX = 0;
    let startWidths = null;
    const boundary = Number(grip.dataset.columnBoundary);
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activeSide = side;
      refreshSelection();
      startX = event.clientX;
      startWidths = [...panel.columns];
      grip.classList.add('is-dragging');
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', (event) => {
      if (!startWidths || !grip.hasPointerCapture(event.pointerId)) return;
      const tableWidth = grip.closest('table').getBoundingClientRect().width;
      const delta = (event.clientX - startX) / tableWidth * 100;
      const leftColumn = boundary;
      const rightColumn = boundary + 1;
      const leftMin = leftColumn === 0 ? 25 : 10;
      const rightMin = rightColumn === 2 ? 15 : 10;
      const leftWidth = Math.max(leftMin, Math.min(startWidths[leftColumn] + startWidths[rightColumn] - rightMin, startWidths[leftColumn] + delta));
      panel.columns[leftColumn] = leftWidth;
      panel.columns[rightColumn] = startWidths[leftColumn] + startWidths[rightColumn] - leftWidth;
      const table = grip.closest('table');
      table.style.setProperty('--name-width', `${panel.columns[0]}%`);
      table.style.setProperty('--size-width', `${panel.columns[1]}%`);
      table.style.setProperty('--date-width', `${panel.columns[2]}%`);
      table.querySelectorAll('col').forEach((col, index) => { col.style.width = `${panel.columns[index]}%`; });
    });
    const finishResize = (event) => {
      if (!startWidths) return;
      startWidths = null;
      grip.classList.remove('is-dragging');
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      persistLayout();
    };
    grip.addEventListener('pointerup', finishResize);
    grip.addEventListener('pointercancel', finishResize);
  });
  element.querySelectorAll('[data-action="up"]').forEach((button) => button.addEventListener('click', () => navigate(side, pathParts(panel.path).length > 1 ? pathParts(panel.path).at(-2).path : panel.path)));
  element.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => navigate(side, panel.path)));
  element.querySelector('[data-action="match-other"]')?.addEventListener('click', () => {
    const otherSide = side === 'left' ? 'right' : 'left';
    if (panels[otherSide].path) navigate(side, panels[otherSide].path);
  });
  element.querySelectorAll('[data-entry]').forEach((row) => {
    const entry = panel.entries[Number(row.dataset.entry)];
    row.addEventListener('click', (event) => {
      activeSide = side;
      if (event.ctrlKey || event.metaKey) {
        panel.selected.has(entry.path) ? panel.selected.delete(entry.path) : panel.selected.add(entry.path);
      } else if (event.shiftKey) {
        const indices = [...panel.selected].map((selected) => panel.entries.findIndex((candidate) => candidate.path === selected)).filter((n) => n >= 0);
        const start = indices.length ? Math.min(...indices) : Number(row.dataset.entry);
        const end = Number(row.dataset.entry);
        panel.selected.clear();
        panel.entries.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((item) => panel.selected.add(item.path));
      } else if (!panel.selected.has(entry.path) || panel.selected.size > 1) {
        panel.selected.clear(); panel.selected.add(entry.path);
      }
      refreshSelection();
    });
    row.addEventListener('dblclick', async () => {
      const result = await window.fileManager.open(entry.path);
      if (result.navigateTo) navigate(side, result.navigateTo);
      else if (result.error) toast(result.error);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (rightDragCandidate?.dragging || Date.now() < suppressRightContextUntil) return;
      activeSide = side;
      if (!panel.selected.has(entry.path)) { panel.selected.clear(); panel.selected.add(entry.path); }
      refreshSelection();
      showContextMenu(event.clientX, event.clientY, side, entry);
    });
    row.addEventListener('dragstart', (event) => {
      activeSide = side;
      if (!panel.selected.has(entry.path)) { panel.selected.clear(); panel.selected.add(entry.path); }
      const paths = getSelected(side).map((item) => item.path);
      event.dataTransfer.setData('application/x-koa-files', JSON.stringify({ side, paths }));
      event.dataTransfer.effectAllowed = 'copyMove';
      setTimeout(refreshSelection, 0);
    });
    row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (event) => {
      event.preventDefault(); row.classList.remove('drop-target');
      await handleDrop(event, side, entry.isDirectory ? entry.path : panel.path);
    });
  });
  element.querySelector('.file-area')?.addEventListener('dragover', (event) => event.preventDefault());
  element.querySelector('.file-area')?.addEventListener('drop', async (event) => {
    if (event.target.closest('[data-entry]')) return;
    event.preventDefault(); await handleDrop(event, side, panel.path);
  });
}
function showContextMenu(x, y, side, entry) {
  const selected = getSelected(side);
  const actions = [
    ['Open', 'Enter', () => window.fileManager.open(entry.path).then((result) => result.navigateTo && navigate(side, result.navigateTo))],
    ['Copy', 'Ctrl+C', () => copySelection(side, false)],
    ['Cut', 'Ctrl+X', () => copySelection(side, true)],
    ['Paste', 'Ctrl+V', () => pasteSelection()],
    ['Delete', 'Delete', () => deleteSelection(side)],
    ['Show in File Explorer', '', () => window.fileManager.showInExplorer(entry.path)]
  ];
  menu.innerHTML = actions.map(([label, shortcut], index) => `${index === 1 || index === 4 ? '<div class="menu-separator"></div>' : ''}<button role="menuitem" data-menu-index="${index}">${label}<kbd>${shortcut}</kbd></button>`).join('');
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - 218)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 220)}px`;
  menu.querySelectorAll('[data-menu-index]').forEach((button) => button.addEventListener('click', () => {
    menu.hidden = true;
    const index = Number(button.dataset.menuIndex);
    actions[index][2]();
  }));
  document.addEventListener('mousedown', hideMenu, { once: true });
}
function hideMenu(event) { if (!menu.contains(event.target)) menu.hidden = true; }

function copySelection(side, cut) {
  const items = getSelected(side);
  if (!items.length) return;
  clipboard = { paths: items.map((item) => item.path), operation: cut ? 'move' : 'copy' };
  setStatus(`${cut ? 'Cut' : 'Copied'} ${items.length} item${items.length === 1 ? '' : 's'}`);
  toast(`${cut ? 'Cut' : 'Copied'} ${items.length} item${items.length === 1 ? '' : 's'}`);
}
async function transferWithConflicts({ sources, destination, operation }) {
  const results = [];
  for (const source of sources) {
    let [result] = await window.fileManager.transfer({ sources: [source], destination, operation });
    while (result?.conflict) {
      const decision = await askTransferConflict(result);
      if (decision.choice === 'cancel') {
        results.push({ source, ok: false, cancelled: true });
        return results;
      }
      if (decision.choice === 'skip') {
        results.push({ source, ok: false, skipped: true });
        result = null;
        break;
      }
      [result] = await window.fileManager.transfer({
        sources: [source], destination, operation,
        conflictAction: decision.choice,
        renameTo: decision.name
      });
    }
    if (result) results.push(result);
  }
  return results;
}
async function pasteSelection() {
  if (!clipboard?.paths.length) return;
  const operation = clipboard.operation;
  const result = await transferWithConflicts({ sources: clipboard.paths, destination: panels[activeSide].path, operation });
  const succeeded = result.filter((item) => item.ok).length;
  const failed = result.find((item) => !item.ok && !item.cancelled && !item.skipped);
  const cancelled = result.some((item) => item.cancelled);
  const skipped = result.filter((item) => item.skipped).length;
  if (operation === 'move' && !failed && !cancelled && succeeded === clipboard.paths.length) clipboard = null;
  await Promise.all([navigate('left', panels.left.path), navigate('right', panels.right.path)]);
  if (failed) toast(failed.error);
  else if (cancelled) toast(succeeded ? `${operation === 'move' ? 'Moved' : 'Copied'} ${succeeded} item${succeeded === 1 ? '' : 's'}; remaining items skipped` : 'Transfer cancelled');
  else if (skipped && succeeded) toast(`${operation === 'move' ? 'Moved' : 'Copied'} ${succeeded} item${succeeded === 1 ? '' : 's'}; skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else if (skipped) toast(`Skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else toast(`${operation === 'move' ? 'Moved' : 'Copied'} ${succeeded} item${succeeded === 1 ? '' : 's'}`);
}
async function deleteSelection(side) {
  const items = getSelected(side);
  if (!items.length) return;
  const outcome = await window.fileManager.delete({ entries: items.map((item) => item.path), confirm: preferences.confirmDelete });
  if (outcome.cancelled) return;
  const failed = outcome.results.find((item) => !item.ok);
  const succeeded = outcome.results.filter((item) => item.ok).length;
  await navigate(side, panels[side].path);
  if (failed) toast(failed.error);
  else if (outcome.permanent) toast(`Permanently deleted ${succeeded} item${succeeded === 1 ? '' : 's'}`);
  else toast(`Moved ${succeeded} item${succeeded === 1 ? '' : 's'} to the Recycle Bin`);
}async function renameSelection(side) {
  const selected = getSelected(side);
  if (!selected.length) { toast('Select one item to rename'); return; }
  if (selected.length > 1) { toast('Rename one item at a time'); return; }
  const item = selected[0];
  const name = window.prompt('Rename item:', item.name);
  if (name === null || name === item.name) return;
  try {
    await window.fileManager.rename({ source: item.path, name });
    await navigate(side, panels[side].path);
    toast('Item renamed');
  } catch (error) {
    toast(error.message);
  }
}
async function handleDrop(event, destinationSide, destination) {
  let payload;
  try { payload = JSON.parse(event.dataTransfer.getData('application/x-koa-files')); } catch { return; }
  const operation = event.ctrlKey ? 'copy' : 'move';
  const result = await transferWithConflicts({ sources: payload.paths, destination, operation });
  const failed = result.find((item) => !item.ok && !item.cancelled && !item.skipped);
  const cancelled = result.some((item) => item.cancelled);
  await Promise.all([navigate('left', panels.left.path), navigate('right', panels.right.path)]);
  const succeeded = result.filter((item) => item.ok).length;
  const skipped = result.filter((item) => item.skipped).length;
  if (failed) toast(failed.error);
  else if (cancelled) toast(succeeded ? `${operation === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}; remaining items skipped` : 'Transfer cancelled');
  else if (skipped && succeeded) toast(`${operation === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}; skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else if (skipped) toast(`Skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else toast(`${operation === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}`);
}

function clearRightDropTargets() {
  document.querySelectorAll('.panel.right-drop-target,.panel [data-entry].right-drop-target').forEach((element) => element.classList.remove('right-drop-target'));
}
function updateRightDropTarget(x, y) {
  clearRightDropTargets();
  const underPointer = document.elementFromPoint(x, y);
  const targetPanel = underPointer?.closest('.panel');
  if (!targetPanel || targetPanel.dataset.panel === rightDragCandidate.side) {
    rightDragCandidate.destination = null;
    return;
  }
  const side = targetPanel.dataset.panel;
  const row = underPointer.closest('[data-entry]');
  const targetEntry = row ? panels[side].entries[Number(row.dataset.entry)] : null;
  const destination = targetEntry?.isDirectory ? targetEntry.path : panels[side].path;
  rightDragCandidate.destination = destination ? { side, path: destination } : null;
  if (rightDragCandidate.destination) {
    (targetEntry?.isDirectory ? row : targetPanel).classList.add('right-drop-target');
  }
}
function openDropActionMenu(paths, destination, x, y) {
  pendingRightDrop = { paths, destination };
  dropActionMenu.hidden = false;
  const width = dropActionMenu.offsetWidth;
  const height = dropActionMenu.offsetHeight;
  dropActionMenu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
  dropActionMenu.style.top = `${Math.max(6, Math.min(y, innerHeight - height - 6))}px`;
}
document.addEventListener('pointerdown', (event) => {
  if (event.button !== 2) return;
  const row = event.target.closest('[data-entry]');
  const panelElement = row?.closest('.panel');
  if (!row || !panelElement) return;
  const side = panelElement.dataset.panel;
  const entry = panels[side].entries[Number(row.dataset.entry)];
  if (!entry) return;
  const panel = panels[side];
  rightDragCandidate = {
    pointerId: event.pointerId,
    side,
    entry,
    paths: panel.selected.has(entry.path) ? getSelected(side).map((item) => item.path) : [entry.path],
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    destination: null
  };
});
document.addEventListener('pointermove', (event) => {
  const drag = rightDragCandidate;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) {
    drag.dragging = true;
    document.body.classList.add('right-dragging');
    activeSide = drag.side;
    const panel = panels[drag.side];
    if (!panel.selected.has(drag.entry.path)) { panel.selected.clear(); panel.selected.add(drag.entry.path); }
    refreshSelection();
  }
  if (!drag.dragging) return;
  event.preventDefault();
  updateRightDropTarget(event.clientX, event.clientY);
});
window.addEventListener('pointerup', (event) => {
  const drag = rightDragCandidate;
  if (!drag || drag.pointerId !== event.pointerId) return;
  rightDragCandidate = null;
  if (!drag.dragging) return;
  document.body.classList.remove('right-dragging');
  event.preventDefault();
  clearRightDropTargets();
  suppressRightContextUntil = Date.now() + 700;
  if (drag.destination) openDropActionMenu(drag.paths, drag.destination, event.clientX, event.clientY);
  else toast('Drop on the other panel to choose an action');
});
window.addEventListener('pointercancel', (event) => {
  if (rightDragCandidate?.pointerId !== event.pointerId) return;
  rightDragCandidate = null;
  document.body.classList.remove('right-dragging');
  clearRightDropTargets();
});
document.addEventListener('contextmenu', (event) => {
  if (rightDragCandidate?.dragging || Date.now() < suppressRightContextUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
});
dropActionMenu.addEventListener('click', async (event) => {
  const choice = event.target.closest('[data-drop-choice]')?.dataset.dropChoice;
  const drop = pendingRightDrop;
  if (!choice || !drop) return;
  dropActionMenu.hidden = true;
  pendingRightDrop = null;
  if (choice === 'cancel') return;
  if (choice === 'shortcut') {
    const results = await window.fileManager.createShortcuts({ sources: drop.paths, destination: drop.destination.path });
    const failed = results.find((item) => !item.ok);
    await navigate(drop.destination.side, panels[drop.destination.side].path);
    toast(failed ? failed.error : `Created ${results.length} shortcut${results.length === 1 ? '' : 's'}`);
    return;
  }
  const results = await transferWithConflicts({ sources: drop.paths, destination: drop.destination.path, operation: choice });
  const failed = results.find((item) => !item.ok && !item.cancelled && !item.skipped);
  const cancelled = results.some((item) => item.cancelled);
  const skipped = results.filter((item) => item.skipped).length;
  const succeeded = results.filter((item) => item.ok).length;
  await Promise.all([navigate('left', panels.left.path), navigate('right', panels.right.path)]);
  if (failed) toast(failed.error);
  else if (cancelled) toast(succeeded ? `${choice === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}; remaining items skipped` : 'Transfer cancelled');
  else if (skipped && succeeded) toast(`${choice === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}; skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else if (skipped) toast(`Skipped ${skipped} existing item${skipped === 1 ? '' : 's'}`);
  else toast(`${choice === 'copy' ? 'Copied' : 'Moved'} ${succeeded} item${succeeded === 1 ? '' : 's'}`);
});
document.addEventListener('mousedown', (event) => {
  if (!dropActionMenu.contains(event.target)) {
    dropActionMenu.hidden = true;
    pendingRightDrop = null;
  }
});

document.addEventListener('click', (event) => {
  const panelElement = event.target.closest('.panel');
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (panelElement) activeSide = panelElement.dataset.panel;
  else if (!action) return;
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === activeSide));
  updateSummary();
  if (action === 'copy') copySelection(activeSide, false);
  if (action === 'cut') copySelection(activeSide, true);
  if (action === 'paste') pasteSelection();
  if (action === 'rename') renameSelection(activeSide);
  if (action === 'delete') deleteSelection(activeSide);
  if (action === 'new-folder') createFolder(activeSide);
  if (action === 'back') moveHistory(activeSide, -1);
  if (action === 'forward') moveHistory(activeSide, 1);
});
document.addEventListener('keydown', async (event) => {
  if (!conflictBackdrop.hidden) {
    if (event.key === 'Escape') finishConflictDecision({ choice: 'cancel' });
    return;
  }
  if (!settingsBackdrop.hidden) {
    if (event.key === 'Escape') closeSettings();
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelection(activeSide, false); }
  else if (mod && event.key.toLowerCase() === 'x') { event.preventDefault(); copySelection(activeSide, true); }
  else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); await pasteSelection(); }
  else if (event.key === 'Delete') { event.preventDefault(); await deleteSelection(activeSide); }
  else if (event.key === 'Enter') {
    const entry = getSelected(activeSide)[0];
    if (entry) { const result = await window.fileManager.open(entry.path); if (result.navigateTo) navigate(activeSide, result.navigateTo); }
  }
  else if (event.key === 'Escape') {
    menu.hidden = true;
    historyMenu.hidden = true;
    dropActionMenu.hidden = true;
    pendingRightDrop = null;
    if (!settingsBackdrop.hidden) closeSettings();
  }
});

document.querySelector('#settings-button').addEventListener('click', openSettings);
document.querySelector('#settings-close').addEventListener('click', closeSettings);
document.querySelectorAll('.settings-category').forEach((button) => button.addEventListener('click', () => {
  settingsCategory = button.dataset.category;
  renderSettingsCategory();
}));
settingsContent.addEventListener('change', (event) => {
  const setField = event.target.closest('[data-set-field]');
  if (setField && directorySetDraft) {
    directorySetDraft[setField.dataset.setField] = setField.value;
    if (setField.dataset.setField === 'type') {
      if (setField.value === 'pair') {
        directorySetDraft.leftPath ||= panels.left.path || '';
        directorySetDraft.rightPath ||= panels.right.path || '';
      } else directorySetDraft.path ||= panels[activeSide].path || '';
      renderDirectorySets();
    }
    return;
  }
  const control = event.target.closest('[data-preference]');
  if (!control) return;
  preferences[control.dataset.preference] = control.type === 'checkbox' ? control.checked : control.value;
  savePreferences();
  if (control.dataset.preference === 'showHidden' || control.dataset.preference === 'groupFolders') {
    renderPanel('left');
    renderPanel('right');
  }
  if (control.dataset.preference === 'dateFormat' || control.dataset.preference === 'timeFormat') {
    renderPanel('left');
    renderPanel('right');
  }
});
settingsContent.addEventListener('input', (event) => {
  const field = event.target.closest('[data-set-field]');
  if (field && directorySetDraft && field.dataset.setField !== 'type') {
    directorySetDraft[field.dataset.setField] = field.value;
  }
});
settingsContent.addEventListener('click', async (event) => {
  if (event.target.closest('[data-cache-browse]')) {
    const input = settingsContent.querySelector('#thumbnail-cache-path');
    try {
      const directory = await window.fileManager.chooseDirectory(input.value.trim() || defaultThumbnailCachePath);
      if (directory) {
        preferences.thumbnailCachePath = directory;
        savePreferences();
        renderSettingsCategory();
      }
    } catch (error) { toast(`Could not choose cache folder: ${error.message}`); }
    return;
  }
  if (event.target.closest('[data-cache-default]')) {
    preferences.thumbnailCachePath = '';
    savePreferences();
    renderSettingsCategory();
    return;
  }
  if (event.target.closest('[data-clear-thumbnail-cache]')) {
    const button = event.target.closest('[data-clear-thumbnail-cache]');
    const input = settingsContent.querySelector('#thumbnail-cache-path');
    const status = settingsContent.querySelector('#thumbnail-cache-status');
    preferences.thumbnailCachePath = input.value.trim();
    savePreferences();
    button.disabled = true;
    status.textContent = 'Clearing cached thumbnails…';
    try {
      const count = await window.fileManager.clearThumbnailCache(preferences.thumbnailCachePath);
      status.textContent = `Cleared ${count} cached thumbnail${count === 1 ? '' : 's'}.`;
    } catch (error) {
      status.textContent = `Could not clear the cache: ${error.message}`;
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (event.target.closest('[data-new-set]')) {
    directorySetDraft = { index: null, type: 'single', path: panels[activeSide].path || '', openIn: 'active', name: '' };
    renderDirectorySets();
    return;
  }
  const usePanel = event.target.closest('[data-use-panel]');
  if (usePanel && directorySetDraft) {
    const side = usePanel.dataset.usePanel;
    const field = directorySetDraft.type === 'pair' ? `${side}Path` : 'path';
    directorySetDraft[field] = panels[side].path || '';
    renderDirectorySets();
    return;
  }
  const browse = event.target.closest('[data-browse-field]');
  if (browse && directorySetDraft) {
    try {
      const directory = await window.fileManager.chooseDirectory();
      if (directory) {
        directorySetDraft[browse.dataset.browseField] = directory;
        renderDirectorySets();
      }
    } catch (error) { toast(`Could not open folder picker: ${error.message}`); }
    return;
  }
  if (event.target.closest('[data-cancel-set]')) {
    directorySetDraft = null;
    renderDirectorySets();
    return;
  }
  if (event.target.closest('[data-save-set]')) {
    const draft = directorySetDraft;
    const requiredPaths = draft.type === 'pair' ? [draft.leftPath, draft.rightPath] : [draft.path];
    if (requiredPaths.some((directory) => !directory?.trim())) { toast('Enter a directory for each panel'); return; }
    const record = draft.type === 'pair'
      ? { type: 'pair', leftPath: draft.leftPath.trim(), rightPath: draft.rightPath.trim(), name: (draft.name || '').trim() }
      : { type: 'single', path: draft.path.trim(), openIn: draft.openIn || 'active', name: (draft.name || '').trim() };
    if (draft.index === null) preferences.directorySets.push(record);
    else preferences.directorySets[draft.index] = record;
    savePreferences();
    directorySetDraft = null;
    renderDirectorySets();
    return;
  }
  const remove = event.target.closest('[data-remove-set]');
  if (remove) {
    preferences.directorySets.splice(Number(remove.dataset.removeSet), 1);
    savePreferences();
    renderDirectorySets();
    return;
  }
  const edit = event.target.closest('[data-edit-set]');
  if (edit) {
    directorySetDraft = { ...preferences.directorySets[Number(edit.dataset.editSet)], index: Number(edit.dataset.editSet) };
    renderDirectorySets();
    return;
  }
  const open = event.target.closest('[data-open-set]');
  if (open) {
    const set = preferences.directorySets[Number(open.dataset.openSet)];
    if (!set) return;
    closeSettings();
    if (set.type === 'pair') Promise.all([navigate('left', set.leftPath), navigate('right', set.rightPath)]);
    else navigate(set.openIn === 'active' ? activeSide : set.openIn, set.path);
  }
});

async function initialize() {
  const home = await window.fileManager.list(undefined).catch(() => null);
  const start = home?.path || 'C:\\';
  const docs = `${start.replace(/[\\/]$/, '')}${start.includes('\\') ? '\\' : '/'}Documents`;
  const savedLeft = typeof savedLayout.left?.path === 'string' ? savedLayout.left.path : null;
  const savedRight = typeof savedLayout.right?.path === 'string' ? savedLayout.right.path : null;
  const leftOpened = await navigate('left', savedLeft || start);
  if (!leftOpened && savedLeft) await navigate('left', start);
  const rightStart = savedRight || docs;
  let rightExists = await window.fileManager.list(rightStart).catch(() => null);
  if (!rightExists && savedRight) rightExists = await window.fileManager.list(docs).catch(() => null);
  await navigate('right', rightExists?.path || start);
  layoutInitialized = true;
  persistLayout();
}
initialize();

document.querySelectorAll('.menu-trigger').forEach((trigger) => {
  trigger.addEventListener('click', () => {
    const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.menu-trigger').forEach((item) => {
      item.setAttribute('aria-expanded', 'false');
      item.nextElementSibling.hidden = true;
    });
    if (!wasOpen) {
      trigger.setAttribute('aria-expanded', 'true');
      trigger.nextElementSibling.hidden = false;
    }
  });
});
document.addEventListener('click', (event) => {
  if (event.target.closest('.menu-group')) return;
  document.querySelectorAll('.menu-trigger').forEach((trigger) => {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.nextElementSibling.hidden = true;
  });
});












document.querySelectorAll('.menu-group').forEach((group) => {
  group.addEventListener('mouseenter', () => {
    const triggers = [...document.querySelectorAll('.menu-trigger')];
    const menuIsOpen = triggers.some((trigger) => trigger.getAttribute('aria-expanded') === 'true');
    if (!menuIsOpen) return;
    const current = group.querySelector('.menu-trigger');
    triggers.forEach((trigger) => {
      const shouldOpen = trigger === current;
      trigger.setAttribute('aria-expanded', String(shouldOpen));
      trigger.nextElementSibling.hidden = !shouldOpen;
    });
  });
});

const workspaceElement = document.querySelector('.workspace');
const splitterElement = document.querySelector('.splitter');
let panelRatio = Number.isFinite(savedLayout.panelRatio) ? savedLayout.panelRatio : 0.5;
function setPanelRatio(ratio) {
  const availableWidth = Math.max(1, workspaceElement.clientWidth - splitterElement.offsetWidth);
  const minimumRatio = Math.min(0.5, 240 / availableWidth);
  panelRatio = Math.max(minimumRatio, Math.min(1 - minimumRatio, ratio));
  workspaceElement.style.setProperty('--left-panel', `${panelRatio}fr`);
  workspaceElement.style.setProperty('--right-panel', `${1 - panelRatio}fr`);
  splitterElement.setAttribute('aria-valuenow', String(Math.round(panelRatio * 100)));
}
setPanelRatio(panelRatio);
let resizingPointerId = null;
splitterElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  splitterElement.focus({ preventScroll: true });
  event.preventDefault();
  resizingPointerId = event.pointerId;
  splitterElement.classList.add('is-dragging');
  splitterElement.setPointerCapture(event.pointerId);
});
splitterElement.addEventListener('pointermove', (event) => {
  if (resizingPointerId !== event.pointerId) return;
  const bounds = workspaceElement.getBoundingClientRect();
  const availableWidth = Math.max(1, bounds.width - splitterElement.offsetWidth);
  const leftWidth = event.clientX - bounds.left - splitterElement.offsetWidth / 2;
  setPanelRatio(leftWidth / availableWidth);
});
function stopPanelResize(event) {
  if (resizingPointerId !== event.pointerId) return;
  resizingPointerId = null;
  splitterElement.classList.remove('is-dragging');
  if (splitterElement.hasPointerCapture(event.pointerId)) splitterElement.releasePointerCapture(event.pointerId);
  persistLayout();
}
splitterElement.addEventListener('pointerup', stopPanelResize);
splitterElement.addEventListener('pointercancel', stopPanelResize);
splitterElement.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    setPanelRatio(panelRatio + (event.key === 'ArrowRight' ? 0.01 : -0.01));
    persistLayout();
  }
});
window.addEventListener('beforeunload', persistLayout);



