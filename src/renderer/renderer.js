const panels = {
  left: { element: document.querySelector('#panel-left'), path: null, entries: [], selected: new Set(), view: 'details', iconSize: 48 },
  right: { element: document.querySelector('#panel-right'), path: null, entries: [], selected: new Set(), view: 'details', iconSize: 48 }
};
let activeSide = 'left';
let clipboard = null;
let toastTimer;
const status = document.querySelector('#status-message');
const summary = document.querySelector('#selection-summary');
const menu = document.querySelector('#context-menu');

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

function kind(entry) {
  if (entry.isDirectory) return 'folder';
  const ext = entry.name.split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','gif','webp','bmp','svg','heic'].includes(ext)) return 'image';
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
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
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

async function navigate(side, directory) {
  const panel = panels[side];
  setStatus('Loading folder…');
  try {
    const result = await window.fileManager.list(directory);
    panel.path = result.path;
    panel.entries = result.entries;
    panel.selected.clear();
    renderPanel(side);
    setStatus('Ready');
  } catch (error) {
    toast(`Could not open folder: ${error.message}`);
    setStatus('Could not load folder');
  }
}

function panelChrome(side) {
  const panel = panels[side];
  const parts = panel.path ? pathParts(panel.path) : [];
  const crumbs = parts.map((part, index) => `<span class="crumb" data-crumb="${index}">${escapeHtml(part.label)}</span>${index < parts.length - 1 ? '<span class="crumb-sep">›</span>' : ''}`).join('');
  const active = activeSide === side;
  return `<div class="panel-top">
    <div class="panel-heading"><span class="panel-label">${side === 'left' ? 'Left' : 'Right'}</span><button class="panel-drive" data-action="drives" title="Choose a drive">${escapeHtml((panel.path || '').slice(0, 2) || '—')}</button><div class="panel-title">${escapeHtml(parts.at(-1)?.label || 'Loading…')}</div>
    <div class="panel-actions"><button class="icon-button" data-action="up" title="Go up one folder">↑</button><button class="icon-button" data-action="refresh" title="Refresh">↻</button><button class="icon-button" data-action="new-folder" title="New folder">＋</button></div></div>
    <div class="pathbar"><span class="path-home">⌂</span>${crumbs}</div>
  </div>
  <div class="toolbar"><button class="toolbar-button" data-action="copy" title="Copy (Ctrl+C)">Copy</button><button class="toolbar-button" data-action="move" title="Move selected items">Move</button><button class="toolbar-button" data-action="delete" title="Delete (Delete)">Delete</button><span class="toolbar-spacer"></span>
    <div class="view-group"><button class="view-button ${panel.view === 'details' ? 'active' : ''}" data-view="details" title="Details">${gridIcon('details')}</button><button class="view-button ${panel.view === 'icons' ? 'active' : ''}" data-view="icons" title="Icons">${gridIcon('icons')}</button></div>
    ${panel.view === 'icons' ? `<label class="size-control" title="Icon size">${panel.iconSize}<input type="range" min="32" max="112" step="8" value="${panel.iconSize}" data-action="icon-size"></label>` : ''}
  </div>`;
}
function gridIcon(type) {
  return type === 'details'
    ? '<svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><path d="M5 3v2M5 7v2M5 11v2"/></svg>'
    : '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/></svg>';
}

function entryAttributes(entry, side, index, tile = false) {
  const cls = kind(entry);
  const selected = panels[side].selected.has(entry.path);
  return `${tile ? 'class="icon-tile' : 'class="file-row'} ${selected ? 'selected' : ''}" data-entry="${index}" draggable="true" tabindex="0"`;
}
function renderEntries(side) {
  const panel = panels[side];
  if (panel.view === 'details') {
    const rows = panel.entries.map((entry, index) => `<tr ${entryAttributes(entry, side, index)}><td><div class="name-cell"><span class="file-icon ${kind(entry)}">${icon(kind(entry))}</span><span class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span></div></td><td>${formatSize(entry.size, entry.isDirectory)}</td><td class="date-cell">${formatDate(entry.modified)}</td></tr>`).join('');
    return `<div class="file-area"><table class="file-list"><thead><tr><th>Name</th><th>Size</th><th>Date modified</th></tr></thead><tbody>${rows}</tbody></table>${panel.entries.length ? '' : '<div class="empty-state">'+icon('folder')+'<strong>This folder is empty</strong><span>Drop files here to add them</span></div>'}</div>`;
  }
  const tileSize = Math.round(panel.iconSize * 1.9);
  const tiles = panel.entries.map((entry, index) => `<div ${entryAttributes(entry, side, index, true)}><div class="tile-visual ${kind(entry)}" style="width:${panel.iconSize}px;height:${panel.iconSize}px">${icon(kind(entry))}</div><div class="tile-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div></div>`).join('');
  return `<div class="file-area"><div class="icon-grid" style="--tile-width:${tileSize}px">${tiles}</div>${panel.entries.length ? '' : '<div class="empty-state">'+icon('folder')+'<strong>This folder is empty</strong><span>Drop files here to add them</span></div>'}</div>`;
}
function renderPanel(side) {
  const panel = panels[side];
  const selectedCount = panel.selected.size;
  const itemCount = panel.entries.length;
  panel.element.classList.toggle('is-active', activeSide === side);
  panel.element.innerHTML = `${panelChrome(side)}${renderEntries(side)}<div class="panel-bottom"><strong>${selectedCount || itemCount}</strong>&nbsp;${selectedCount ? 'selected' : 'items'}<span class="bottom-spacer"></span>${panel.path ? escapeHtml(panel.path) : ''}</div>`;
  bindPanel(side);
  updateSummary();
}
function updateSummary() {
  const panel = panels[activeSide];
  const count = panel.selected.size;
  const bytes = panel.entries.filter((entry) => panel.selected.has(entry.path)).reduce((sum, entry) => sum + (entry.size || 0), 0);
  summary.textContent = count ? `${count} selected · ${formatSize(bytes, false)}` : 'Nothing selected';
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
    if (bottom) bottom.innerHTML = `<strong>${panel.selected.size || panel.entries.length}</strong>&nbsp;${panel.selected.size ? 'selected' : 'items'}<span class="bottom-spacer"></span>${escapeHtml(panel.path || '')}`;
  });
  updateSummary();
}
function bindPanel(side) {
  const panel = panels[side];
  const element = panel.element;
  element.querySelectorAll('[data-crumb]').forEach((crumb) => crumb.addEventListener('click', () => {
    const part = pathParts(panel.path)[Number(crumb.dataset.crumb)];
    if (part) navigate(side, part.path);
  }));
  element.querySelectorAll('[data-action="up"]').forEach((button) => button.addEventListener('click', () => navigate(side, pathParts(panel.path).length > 1 ? pathParts(panel.path).at(-2).path : panel.path)));
  element.querySelectorAll('[data-action="refresh"]').forEach((button) => button.addEventListener('click', () => navigate(side, panel.path)));
  element.querySelectorAll('[data-action="new-folder"]').forEach((button) => button.addEventListener('click', async () => {
    const name = window.prompt('Name the new folder:');
    if (!name) return;
    try { await window.fileManager.createFolder({ parent: panel.path, name }); navigate(side, panel.path); }
    catch (error) { toast(error.message); }
  }));
  element.querySelectorAll('[data-action="drives"]').forEach((button) => button.addEventListener('click', async () => {
    const roots = await window.fileManager.roots();
    if (!roots.length) return;
    const currentRoot = roots.findIndex((root) => panel.path.toLowerCase().startsWith(root.path.toLowerCase()));
    const choices = roots.map((root, index) => `${index + 1}. ${root.name}`).join('\n');
    const answer = window.prompt(`Open drive or location by number:\n${choices}`, String(Math.max(currentRoot + 1, 1)));
    const selected = roots[Number(answer) - 1];
    if (selected) navigate(side, selected.path);
  }));
  element.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { panel.view = button.dataset.view; renderPanel(side); }));
  element.querySelectorAll('[data-action="icon-size"]').forEach((input) => input.addEventListener('change', () => { panel.iconSize = Number(input.value); renderPanel(side); }));
  element.addEventListener('mousedown', (event) => {
    const inFileArea = event.target.closest('.file-area');
    if (inFileArea && !event.target.closest('[data-entry]')) {
      panel.selected.clear();
      activeSide = side;
      refreshSelection();
    }
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
async function pasteSelection() {
  if (!clipboard?.paths.length) return;
  const operation = clipboard.operation;
  const result = await window.fileManager.transfer({ sources: clipboard.paths, destination: panels[activeSide].path, operation });
  const succeeded = result.filter((item) => item.ok).length;
  const failed = result.filter((item) => !item.ok);
  if (operation === 'move' && !failed.length) clipboard = null;
  await Promise.all([navigate('left', panels.left.path), navigate('right', panels.right.path)]);
  toast(failed.length ? failed[0].error : `${operation === 'move' ? 'Moved' : 'Copied'} ${succeeded} item${succeeded === 1 ? '' : 's'}`);
}
async function deleteSelection(side) {
  const items = getSelected(side);
  if (!items.length) return;
  const result = await window.fileManager.delete(items.map((item) => item.path));
  const failed = result.find((item) => !item.ok);
  await navigate(side, panels[side].path);
  toast(failed ? failed.error : `Moved ${items.length} item${items.length === 1 ? '' : 's'} to the Recycle Bin`);
}
async function handleDrop(event, destinationSide, destination) {
  let payload;
  try { payload = JSON.parse(event.dataTransfer.getData('application/x-koa-files')); } catch { return; }
  const operation = event.ctrlKey ? 'copy' : 'move';
  const result = await window.fileManager.transfer({ sources: payload.paths, destination, operation });
  const failed = result.find((item) => !item.ok);
  await Promise.all([navigate('left', panels.left.path), navigate('right', panels.right.path)]);
  toast(failed ? failed.error : `${operation === 'copy' ? 'Copied' : 'Moved'} ${payload.paths.length} item${payload.paths.length === 1 ? '' : 's'}`);
}

document.addEventListener('click', (event) => {
  const panelElement = event.target.closest('.panel');
  if (!panelElement) return;
  activeSide = panelElement.dataset.panel;
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === activeSide));
  updateSummary();
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'copy') copySelection(activeSide, false);
  if (action === 'move') copySelection(activeSide, true);
  if (action === 'delete') deleteSelection(activeSide);
});
document.addEventListener('keydown', async (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelection(activeSide, false); }
  else if (mod && event.key.toLowerCase() === 'x') { event.preventDefault(); copySelection(activeSide, true); }
  else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); await pasteSelection(); }
  else if (event.key === 'Delete') { event.preventDefault(); await deleteSelection(activeSide); }
  else if (event.key === 'Enter') {
    const entry = getSelected(activeSide)[0];
    if (entry) { const result = await window.fileManager.open(entry.path); if (result.navigateTo) navigate(activeSide, result.navigateTo); }
  }
  else if (event.key === 'Escape') menu.hidden = true;
});

async function initialize() {
  const home = await window.fileManager.list(undefined).catch(() => null);
  const start = home?.path || 'C:\\';
  const docs = `${start.replace(/[\\/]$/, '')}${start.includes('\\') ? '\\' : '/'}Documents`;
  await navigate('left', start);
  const rightExists = await window.fileManager.list(docs).catch(() => null);
  await navigate('right', rightExists?.path || start);
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
