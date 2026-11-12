const byId = id => document.getElementById(id);
const themeSelect = byId('theme-select');
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeColors = new Map([
  ['studio', '#f3f5fc'],
  ['amber', '#f8f4eb'],
  ['ocean', '#f1f7ff'],
  ['lavender', '#f7f3fc'],
  ['monochrome', '#f7f7f7'],
  ['classic-blue', '#f8fafd'],
  ['forest-lime', '#f3f6ef']
]);

function applyTheme(theme) {
  const selected = theme === 'classic-green' ? 'monochrome' : themeColors.has(theme) ? theme : 'classic-blue';
  document.documentElement.dataset.theme = selected;
  themeSelect.value = selected;

  updateAppearance();
}

const appearanceSelect = byId('appearance-select');
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
let appearance = 'system';
try {
  const saved = localStorage.getItem('drivepool-appearance');
  if (['system', 'light', 'dark'].includes(saved)) appearance = saved;
} catch {}
appearanceSelect.value = appearance;
function updateAppearance() {
  const dark = appearance === 'dark' || (appearance === 'system' && systemAppearance.matches);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  themeColor.content = dark ? '#171c20' : themeColors.get(document.documentElement.dataset.theme);
}
systemAppearance.addEventListener('change', updateAppearance);
appearanceSelect.addEventListener('change', () => {
  appearance = appearanceSelect.value;
  try { localStorage.setItem('drivepool-appearance', appearance); } catch {}
  updateAppearance();
});

let savedTheme;
try { savedTheme = localStorage.getItem('drivepool-theme'); } catch {}
let driveAppearanceApplied = false;
try { driveAppearanceApplied = localStorage.getItem('drivepool-drive-appearance') === '1'; } catch {}
applyTheme(driveAppearanceApplied && savedTheme !== 'monochrome' ? savedTheme : 'classic-blue');
try {
  localStorage.setItem('drivepool-drive-appearance', '1');
  localStorage.setItem('drivepool-theme', document.documentElement.dataset.theme);
} catch {}

themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
  try { localStorage.setItem('drivepool-theme', themeSelect.value); } catch {}
});

const notice = byId('message');
const chooser = byId('file');
const upload = byId('choose');
const progress = byId('progress');

function message(text) {
  notice.textContent = text;
  notice.hidden = !text;
}

async function read(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

function bytes(size) {
  if (size == null) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(4, Math.floor(Math.log10(Math.max(1, size)) / 3));
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
    .format(size / 1000 ** unit) + ' ' + units[unit];
}

function row(title, detail, action) {
  const item = document.createElement('li');
  const label = document.createElement('div');
  const name = document.createElement('strong');
  const subtitle = document.createElement('small');
  name.textContent = title;
  subtitle.textContent = detail;
  label.append(name, subtitle);
  item.append(label);
  if (action) item.append(action);
  return item;
}

function storageBadge(free) {
  const badge = document.createElement('span');
  badge.className = 'storage-badge';
  badge.textContent = free == null ? 'Unknown' : bytes(free) + ' free';
  return badge;
}

let dashboardRequest = 0;
let followUpRefresh;
async function refreshAfterChange() {
  clearTimeout(followUpRefresh);
  try {
    await refresh();
  } finally {
    clearTimeout(followUpRefresh);
    followUpRefresh = setTimeout(() => refresh().catch(() => {}), 1800);
  }
}

async function refresh() {
  const request = ++dashboardRequest;
  const button = byId('refresh');
  button.disabled = true;
  try {
    const { accounts, splitFiles = [], folders = [] } = await read('/api/dashboard');
    if (request !== dashboardRequest) return;
    const measured = accounts.filter(account => account.free != null);
    byId('free-label').textContent = measured.length === accounts.length ? 'Total free space' : 'Known free space';
    byId('free').textContent = measured.length ? bytes(measured.reduce((sum, account) => sum + account.free, 0)) : '—';
    byId('largest').textContent = measured.length ? bytes(measured.reduce((sum, account) => sum + account.max, 0)) : '—';
    byId('count').textContent = accounts.length;
    const quotaAccounts = accounts.filter(account => account.free != null && account.total != null);
    const total = quotaAccounts.reduce((sum, account) => sum + account.total, 0);
    const free = quotaAccounts.reduce((sum, account) => sum + account.free, 0);
    const partial = quotaAccounts.length !== accounts.length ? 'Known ' : '';
    byId('storage-capacity').textContent = quotaAccounts.length
      ? partial + bytes(total - free) + ' used of ' + bytes(total) : 'Storage capacity unavailable';
    byId('storage-free').textContent = quotaAccounts.length ? bytes(free) + ' free' : '';
    byId('storage-meter').hidden = !quotaAccounts.length;
    byId('storage-meter').value = total > 0 ? Math.max(0, Math.min(100, (total - free) / total * 100)) : 0;
    byId('accounts').replaceChildren(...accounts.map(account =>
      row(account.email, account.unavailable ? 'Some account data is unavailable. Refresh or reconnect.' : 'Google Drive',
        storageBadge(account.free))
    ));
    savedFolders = folders;
    files = [...splitFiles, ...accounts.flatMap(account => account.files.map(file => ({ ...file, account })))]
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
    renderFiles();
  } finally {
    if (request === dashboardRequest) button.disabled = false;
  }
}

let files = [];
let savedFolders = [];
let showingBin = false;
let fileLayout = 'grid';
try { if (localStorage.getItem('drivepool-view') === 'list') fileLayout = 'list'; } catch {}
let bulkBusy = false;
const selectedFiles = new Set();
let selectionCards = [];
let selectionAnchor = null;
let currentFolder = '';

function typeIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('type-icon', 'type-icon-' + kind);
  const paths = kind === 'folder'
    ? ['M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z']
    : ['M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
       'M6 17l4-5 3 3 2-3 3 5z M17 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z'];
  for (const shape of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', shape);
    svg.append(path);
  }
  return svg;
}

const previewDialog = byId('file-preview-dialog');
const previewContent = byId('preview-content');
let previewController;
let previewUrl;

function releasePreview() {
  previewController?.abort();
  previewContent.replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
}
previewDialog.addEventListener('close', releasePreview);

function previewType(file) {
  const ext = file.name.split('.').at(-1).toLowerCase();
  const formats = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf',
    txt: 'text/plain', csv: 'text/plain', md: 'text/plain', json: 'text/plain',
    log: 'text/plain', xml: 'text/plain', html: 'text/plain', css: 'text/plain', js: 'text/plain',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg'
  };
  if (['docx', 'xlsx', 'xls', 'xlsm', 'ods', 'pptx'].includes(ext)) return 'office';
  if (['doc', 'ppt'].includes(ext)) return 'legacy-office';
  return formats[ext] || '';
}

async function openPreview(file) {
  if (file.trashed) return;
  releasePreview();
  const controller = new AbortController();
  previewController = controller;
  byId('preview-title').textContent = file.name;
  const path = file.split ? '/api/split-download/' + encodeURIComponent(file.id)
    : '/api/download/' + encodeURIComponent(file.account.id) + '/' + encodeURIComponent(file.id);
  byId('preview-download').href = path;
  previewContent.textContent = 'Loading preview…';
  if (!previewDialog.open) previewDialog.showModal();
  const type = previewType(file);
  if (!type) {
    previewContent.textContent = 'Preview is unavailable for this format. Use Download to open it in a compatible application.';
    return;
  }
  if (type === 'legacy-office') {
    if (file.split) {
      previewContent.textContent = 'Save this document as DOCX or PPTX for in-app preview of split files.';
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'legacy-office-preview';
    const note = document.createElement('p');
    note.textContent = 'Google Drive preview. Your browser may need to be signed in to ' + file.account.email + '.';
    const frame = document.createElement('iframe');
    frame.title = file.name;
    frame.src = 'https://drive.google.com/file/d/' + encodeURIComponent(file.id) + '/preview?authuser=' +
      encodeURIComponent(file.account.email);
    wrapper.append(note, frame);
    previewContent.replaceChildren(wrapper);
    return;
  }
  const limit = (type === 'office' ? 20 : 50) * 1024 * 1024;
  if (Number(file.size) > limit) {
    previewContent.textContent = 'Preview supports files up to ' + (limit / 1024 / 1024) + ' MB. Use Download for this file.';
    return;
  }
  try {
    const response = await fetch(path, { signal: controller.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not open this file.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Preview supports files up to ' + (limit / 1024 / 1024) + ' MB. Use Download for this file.');
      }
      chunks.push(value);
    }
    if (controller.signal.aborted) return;
    const blob = new Blob(chunks, { type });
    if (type === 'office') {
      const buffer = await blob.arrayBuffer();
      if (controller.signal.aborted) return;
      const frame = document.createElement('iframe');
      frame.title = file.name + ' — Office preview';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = '/office-viewer.html?v=1';
      frame.addEventListener('load', () => {
        if (!controller.signal.aborted) {
          frame.contentWindow.postMessage({
            type: 'drivepool-office', format: file.name.split('.').at(-1).toLowerCase(), buffer
          }, '*', [buffer]);
        }
      }, { once: true });
      previewContent.replaceChildren(frame);
      return;
    }
    if (type === 'text/plain') {
      const text = document.createElement('pre');
      text.textContent = (await blob.text()).slice(0, 1000000);
      if (controller.signal.aborted) return;
      previewContent.replaceChildren(text);
      return;
    }
    previewUrl = URL.createObjectURL(blob);
    let element;
    if (type.startsWith('image/')) {
      element = document.createElement('img');
      element.alt = file.name;
    } else if (type === 'application/pdf') {
      element = document.createElement('iframe');
      element.title = file.name;
    } else {
      element = document.createElement(type.startsWith('video/') ? 'video' : 'audio');
      element.controls = true;
    }
    element.src = previewUrl;
    element.onerror = () => {
      previewContent.textContent = 'Your browser could not preview this file. Use Download to open it.';
    };
    previewContent.replaceChildren(element);
  } catch (error) {
    if (!controller.signal.aborted) previewContent.textContent = error.message;
  }
}

function fileKind(file) {
  const type = file.mimeType || '';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg|avif|bmp|tiff?)$/i.test(file.name)) return ['Image', '🖼'];
  if (type.includes('spreadsheet') || /\.(xlsx?|csv|ods)$/i.test(file.name)) return ['Spreadsheet', '▦'];
  if (/\.pdf$/i.test(file.name) || type === 'application/pdf') return ['PDF', '▤'];
  if (type.startsWith('text/') || /\.(docx?|odt|txt|rtf|pptx?)$/i.test(file.name)) return ['Document', '▤'];
  if (type.startsWith('video/') || /\.(mp4|mov|mkv|webm)$/i.test(file.name)) return ['Video', '▶'];
  return ['File', '▧'];
}

function openFolder(path) {
  currentFolder = path;
  byId('search').value = '';
  renderFiles();
}

async function runFileAction(file, action, fields = {}) {
  const connection = file.split ? 'split' : file.account.id;
  const endpoint = '/api/file-action/' + encodeURIComponent(connection) + '/' + encodeURIComponent(file.id);
  return read(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...fields })
  });
}

function actionsMenu(name, actions) {
  const menu = document.createElement('details');
  menu.className = 'item-actions';
  const toggle = document.createElement('summary');
  toggle.textContent = '⋮';
  toggle.setAttribute('aria-label', 'Actions for ' + name);
  const panel = document.createElement('div');
  panel.className = 'action-panel';
  for (const [label, handler] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => {
      menu.open = false;
      handler();
    };
    panel.append(button);
  }
  menu.append(toggle, panel);
  menu.ontoggle = () => {
    if (menu.open) document.querySelectorAll('.item-actions[open]').forEach(other => {
      if (other !== menu) other.open = false;
    });
  };
  return menu;
}

document.addEventListener('click', event => {
  document.querySelectorAll('.item-actions[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.item-actions[open]').forEach(menu => {
    menu.open = false;
    menu.querySelector('summary').focus();
  });
});

async function changeFile(file, action) {
  if (bulkBusy) return;
  const fields = {};
  if (action === 'rename') {
    const name = window.prompt('New file name', file.name)?.trim();
    if (!name || name === file.name) return;
    fields.name = name;
  }
  if (action === 'share') {
    const email = window.prompt(file.split
      ? 'Allow this email to download the file after signing in to Drivepool'
      : 'Send a Google Drive invitation with view access to this email')?.trim();
    if (!email) return;
    fields.email = email;
  }
  if (action === 'delete' && !window.confirm('Permanently delete “' + file.name + '”? This cannot be undone.')) return;
  if (action === 'trash' && !window.confirm('Move “' + file.name + '” to Google Drive bin?')) return;

  try {
    const result = await runFileAction(file, action, fields);
    if (result.url) {
      window.prompt('Send this link to the recipient. They must sign in to Drivepool with the invited email first.', result.url);
    }
    const messages = {
      rename: 'File renamed.',
      copy: 'Copy created.',
      trash: 'Moved to Google Drive bin.',
      restore: 'File restored.',
      delete: 'File permanently deleted.',
      share: result.url ? 'Download access granted to the recipient.' : 'Google Drive invitation sent.'
    };
    message(messages[action]);
  } catch (error) {
    message(error.message);
  }
  await refreshAfterChange().catch(error => message(error.message));
}

async function changeFolder(path, action) {
  if (bulkBusy) return;
  const nested = files.filter(file => Boolean(file.trashed) === (action !== 'trash') &&
    (file.folder === path || file.folder?.startsWith(path + '/')));
  const instructions = {
    trash: ['Move to bin', 'moved to bin'],
    restore: ['Restore', 'restored'],
    delete: ['Permanently delete', 'permanently deleted']
  };
  const [verb, outcome] = instructions[action];
  const warning = action === 'delete' ? ' This cannot be undone.' : '';
  if (!window.confirm(verb + ' all ' + nested.length + ' files in “' + path + '”?' + warning)) return;
  let completed = 0;
  try {
    for (const file of nested) {
      await runFileAction(file, action);
      completed++;
    }
    message(completed + ' files ' + outcome + '.');
  } catch (error) {
    message(completed + ' of ' + nested.length + ' files ' + outcome + '. ' + error.message);
  }
  await refreshAfterChange().catch(error => message(error.message));
}

function showBin(value) {
  showingBin = value;
  selectedFiles.clear();
  selectionAnchor = null;
  byId('show-library').setAttribute('aria-pressed', String(!value));
  byId('show-bin').setAttribute('aria-pressed', String(value));
  byId('library-description').textContent = value
    ? 'Restore files to their original folder or delete them permanently.'
    : 'Drop files here or use + New to upload.';
  byId('upload-actions').hidden = value;
  byId('mobile-new').hidden = value;
  byId('bottom-files').setAttribute('aria-pressed', String(!value));
  byId('bottom-trash').setAttribute('aria-pressed', String(value));
  document.querySelector('.mobile-file-tabs span').textContent = value ? 'Trash' : 'My Drive';
  openFolder('');
}

byId('show-library').onclick = () => showBin(false);
byId('show-bin').onclick = () => showBin(true);

function fileKey(file) {
  return (file.split ? 'split' : file.account.id) + '/' + file.id;
}

function syncSelection() {
  const available = files.filter(file => Boolean(file.trashed) === showingBin);
  const selected = available.filter(file => selectedFiles.has(fileKey(file)));
  const selectedCards = selectionCards.filter(({ card, keys }) => {
    const count = keys.filter(key => selectedFiles.has(key)).length;
    card.classList.toggle('is-selected', count > 0);
    card.setAttribute('aria-pressed', count === 0 ? 'false' : count === keys.length ? 'true' : 'mixed');
    return count === keys.length && count > 0;
  });
  const matching = selectedCards.filter(row => row.keys.length === selected.length);
  const single = matching.find(row => row.rowKey === selectionAnchor)
    || (matching.length === 1 ? matching[0] : null);
  for (const action of ['rename', 'copy', 'share']) {
    const button = byId(action + '-selected');
    button.hidden = showingBin || !single;
    button.disabled = bulkBusy;
    button.onclick = single ? () => single.act(action) : null;
  }
  byId('selection-actions').hidden = !selected.length;
  byId('bin-tools').hidden = !showingBin;
  const includesFolder = selectionCards.some(row =>
    row.rowKey.startsWith('folder:') && row.keys.some(key => selectedFiles.has(key)));
  byId('move-selected').hidden = showingBin || includesFolder;
  byId('move-selected').disabled = bulkBusy || !selected.length;
  byId('download-selected').hidden = showingBin;
  byId('download-selected').disabled = bulkBusy || !selected.length;
  byId('move-selected-to-bin').hidden = showingBin;
  byId('move-selected-to-bin').disabled = bulkBusy || !selected.length;
  for (const id of ['restore-selected', 'delete-selected', 'empty-bin']) byId(id).hidden = !showingBin;
  byId('restore-selected').disabled = bulkBusy || !selected.length || selected.some(file => file.purging);
  byId('delete-selected').disabled = bulkBusy || !selected.length;
  byId('empty-bin').disabled = bulkBusy || !available.length;
  const count = single ? 1 : selected.length;
  byId('selection-number').textContent = count;
  byId('selection-label').textContent = count + ' selected';
}

let draggedRows = [];
const internalDragType = 'application/x-drivepool-items';

async function moveDraggedRows(destination) {
  if (bulkBusy || showingBin || !draggedRows.length) return;
  const rows = draggedRows;
  draggedRows = [];
  const folders = rows.filter(row => row.rowKey.startsWith('folder:'))
    .map(row => row.rowKey.slice(7))
    .filter((path, _, all) => !all.some(parent => path.startsWith(parent + '/')));
  if (folders.some(path => destination === path || destination.startsWith(path + '/'))) {
    return message('A folder cannot be moved inside itself.');
  }
  const known = new Set([...savedFolders, ...files.filter(file => !file.trashed).map(file => file.folder)]);
  const targets = folders.map(source => ({
    source, target: [destination, source.split('/').at(-1)].filter(Boolean).join('/')
  })).filter(({ source, target }) => source !== target);
  if (targets.some(({ target }) => [...known].some(path => path === target || path?.startsWith(target + '/')))) {
    return message('A folder with that name already exists at the destination.');
  }
  const keys = new Set(rows.flatMap(row => row.keys));
  const moving = files.filter(file => !file.trashed && keys.has(fileKey(file)));
  bulkBusy = true;
  syncSelection();
  let moved = 0;
  try {
    for (const file of moving) {
      const containing = folders.find(path => file.folder === path || file.folder?.startsWith(path + '/'));
      const mapping = targets.find(row => row.source === containing);
      if (containing && !mapping) continue;
      const folder = mapping ? mapping.target + file.folder.slice(mapping.source.length) : destination;
      if ((file.folder || '') === folder) continue;
      await runFileAction(file, 'move', { folder });
      file.folder = folder;
      moved++;
    }
    for (const { source, target } of targets) {
      await read('/api/folder-paths', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, destination: target })
      });
      savedFolders = savedFolders.map(path =>
        path === source || path.startsWith(source + '/') ? target + path.slice(source.length) : path);
      if (!savedFolders.includes(target)) savedFolders.push(target);
    }
    selectedFiles.clear();
    message('Moved ' + moved + ' files' + (targets.length ? ' and ' + targets.length + ' folders.' : '.'));
  } catch (error) {
    message(moved + ' files moved. Remaining items could not be moved. ' + error.message);
  } finally {
    bulkBusy = false;
    renderFiles();
    await refreshAfterChange().catch(error => message(error.message));
  }
}

function folderDropTarget(element, destination) {
  element.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes(internalDragType) || bulkBusy || showingBin) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    element.classList.add('folder-drop-target');
  });
  element.addEventListener('dragleave', event => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('folder-drop-target');
  });
  element.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes(internalDragType)) return;
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('folder-drop-target');
    void moveDraggedRows(destination);
  });
}

function setupSelectionCard(card, rowKey, name, items, act, activate) {
  const keys = items.map(fileKey);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', name);
  selectionCards.push({ card, keys, rowKey, act });
  card.draggable = !showingBin && !mobileLayout.matches;
  card.addEventListener('dragstart', event => {
    if (bulkBusy || showingBin || mobileLayout.matches || event.target.closest('.item-actions')) {
      event.preventDefault();
      return;
    }
    if (!card.classList.contains('is-selected')) {
      selectedFiles.clear();
      keys.forEach(key => selectedFiles.add(key));
      selectionAnchor = rowKey;
      syncSelection();
    }
    draggedRows = card.classList.contains('is-selected') && keys.length
      ? selectionCards.filter(row => row.keys.length && row.keys.every(key => selectedFiles.has(key)))
      : [selectionCards.find(row => row.rowKey === rowKey)];
    event.dataTransfer.setData(internalDragType, rowKey);
    event.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    draggedRows = [];
    document.querySelectorAll('.folder-drop-target').forEach(el => el.classList.remove('folder-drop-target'));
  });
  const select = event => {
    if (bulkBusy) return;
    const clicked = selectionCards.findIndex(row => row.rowKey === rowKey);
    const anchor = selectionCards.findIndex(row => row.rowKey === selectionAnchor);
    const toggle = mobileLayout.matches || event.ctrlKey || event.metaKey;
    const wasSelected = keys.every(key => selectedFiles.has(key));
    if (!toggle) selectedFiles.clear();
    const range = event.shiftKey && anchor >= 0
      ? selectionCards.slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1)
      : [selectionCards[clicked]];
    for (const row of range) {
      for (const key of row.keys) {
        if (toggle && !event.shiftKey && wasSelected) selectedFiles.delete(key);
        else selectedFiles.add(key);
      }
    }
    if (!event.shiftKey || anchor < 0) selectionAnchor = rowKey;
    syncSelection();
  };
  let pressTimer;
  let touchStart;
  let suppressClick = false;
  const stopPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  card.addEventListener('pointerdown', event => {
    if (!mobileLayout.matches || bulkBusy || event.target.closest('.item-actions') || event.button !== 0) return;
    stopPress();
    suppressClick = false;
    touchStart = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      if (!card.isConnected || bulkBusy) return;
      suppressClick = true;
      if (!keys.every(key => selectedFiles.has(key))) select(event);
      touchStart = undefined;
    }, 500);
  });
  card.addEventListener('pointermove', event => {
    if (touchStart && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) {
      stopPress();
      touchStart = undefined;
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    card.addEventListener(type, () => {
      stopPress();
      touchStart = undefined;
    });
  }
  card.addEventListener('contextmenu', event => {
    if (mobileLayout.matches && !event.target.closest('.item-actions')) event.preventDefault();
  });
  card.addEventListener('click', event => {
    if (event.target.closest('.item-actions') || bulkBusy) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    if (mobileLayout.matches && !selectedFiles.size && !showingBin) {
      activate();
    } else {
      select(event);
    }
  });
  card.addEventListener('keydown', event => {
    if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    select(event);
  });
}

function clearSelection() {
  if (bulkBusy || !selectedFiles.size) return;
  selectedFiles.clear();
  selectionAnchor = null;
  syncSelection();
}

byId('clear-selection').onclick = clearSelection;
document.querySelector('.workspace-main').addEventListener('click', event => {
  if (event.target.closest('.file-item, .folder-item, button, input, a, label, summary')) return;
  clearSelection();
});

async function bulkFileAction(action, empty = false) {
  if (bulkBusy) return;
  const items = files.filter(file => Boolean(file.trashed) === showingBin && (empty || selectedFiles.has(fileKey(file))));
  if (!items.length) return;
  if (action === 'restore' && items.some(file => file.purging)) {
    message('A selected file is already being permanently deleted. Deselect it before restoring.');
    return;
  }
  const verb = { delete: 'Permanently delete', restore: 'Restore', trash: 'Move to bin' }[action];
  const outcome = { delete: 'permanently deleted', restore: 'restored', trash: 'moved to bin' }[action];
  const prompt = empty
    ? 'Permanently delete all ' + items.length + ' files currently listed in the Drivepool Bin?'
    : verb + ' ' + items.length + ' selected files?';
  if (!window.confirm(prompt + (action === 'delete' ? ' This cannot be undone.' : ''))) return;
  bulkBusy = true;
  syncSelection();
  let completed = 0;
  let firstError;
  try {
    for (const file of items) {
      try {
        await runFileAction(file, action);
        selectedFiles.delete(fileKey(file));
        completed++;
      } catch (error) {
        firstError ??= error.message;
      }
    }
    try {
      await refreshAfterChange();
    } catch (error) {
      firstError ??= 'Could not refresh the Bin and storage. ' + error.message;
    }
    const result = completed + ' of ' + items.length + ' files ' +
      outcome + '.';
    message(result + (firstError ? ' ' + firstError : ''));
  } finally {
    bulkBusy = false;
    syncSelection();
  }
}

byId('move-selected-to-bin').onclick = () => bulkFileAction('trash');
byId('restore-selected').onclick = () => bulkFileAction('restore');
byId('delete-selected').onclick = () => bulkFileAction('delete');
byId('empty-bin').onclick = () => bulkFileAction('delete', true);

function folderFiles(path) {
  return files.filter(file => !file.trashed && (file.folder === path || file.folder?.startsWith(path + '/')));
}

function downloadZip(items) {
  if (!items.length) return;
  if (items.length > 2000) {
    message('Select up to 2,000 files per ZIP download.');
    return;
  }
  byId('archive-selection').value = JSON.stringify(items.map(fileKey));
  byId('archive-form').submit();
}

byId('download-selected').onclick = () => {
  const items = files.filter(file => !file.trashed && selectedFiles.has(fileKey(file)));
  if (items.length === 1 && selectionAnchor === fileKey(items[0])) {
    const [connection, id] = fileKey(items[0]).split('/');
    const endpoint = items[0].split ? '/api/split-download/' : '/api/download/' + encodeURIComponent(connection) + '/';
    window.location.assign(endpoint + encodeURIComponent(id));
  } else {
    downloadZip(items);
  }
};

async function updateFolder(path, action) {
  if (bulkBusy) return;
  const items = folderFiles(path);
  if (!items.length) return;
  const pieces = path.split('/');
  const name = pieces.pop();
  let destination;
  let email;
  if (action === 'share') {
    email = window.prompt('Share all ' + items.length + ' files in this folder with this email')?.trim();
    if (!email) return;
  } else {
    const newName = window.prompt(action === 'rename' ? 'New folder name' : 'Name for the folder copy',
      action === 'rename' ? name : 'Copy of ' + name)?.trim();
    if (!newName || newName === name) return;
    if (newName === '.' || newName === '..' || /[\/\\\x00-\x1f\x7f]/.test(newName)) {
      message('Enter a folder name without slashes or control characters.');
      return;
    }
    destination = [...pieces, newName].join('/');
    if (files.some(file => file.folder === destination || file.folder?.startsWith(destination + '/'))) {
      message('A folder with that name already exists.');
      return;
    }
  }

  bulkBusy = true;
  syncSelection();
  let completed = 0;
  const links = [];
  try {
    for (const file of items) {
      const fields = action === 'share' ? { email }
        : { name: file.name, folder: destination + file.folder.slice(path.length) };
      const result = await runFileAction(file, action, fields);
      if (result.url) links.push(file.name + ' ' + result.url);
      completed++;
    }
    message(completed + ' files updated.');
  } catch (error) {
    message(completed + ' of ' + items.length + ' files updated. ' + error.message);
  } finally {
    if (links.length) window.prompt('Send these split-file links to the invited recipient.', links.join(' | '));
    await refreshAfterChange().catch(error => message(error.message));
    bulkBusy = false;
    syncSelection();
  }
}

function renderFiles() {
  const query = byId('search').value.trim().toLowerCase();
  const list = byId('files');
  list.dataset.view = fileLayout;
  byId('file-section').dataset.view = fileLayout;
  byId('folders').dataset.view = fileLayout;
  byId('list-layout').setAttribute('aria-pressed', String(fileLayout === 'list'));
  byId('grid-layout').setAttribute('aria-pressed', String(fileLayout === 'grid'));

  const breadcrumbs = byId('breadcrumbs');
  breadcrumbs.replaceChildren();
  const parts = currentFolder ? currentFolder.split('/') : [];
  const trail = [showingBin ? 'Bin' : 'Your files', ...parts];
  for (const [index, name] of trail.entries()) {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '›';
      breadcrumbs.append(separator);
    }
    if (index === trail.length - 1) {
      const heading = document.createElement('h2');
      heading.textContent = name;
      heading.setAttribute('aria-current', 'location');
      breadcrumbs.append(heading);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.onclick = () => openFolder(parts.slice(0, index).join('/'));
      folderDropTarget(button, parts.slice(0, index).join('/'));
      breadcrumbs.append(button);
    }
  }

  const folders = new Set();
  const visibleFiles = [];
  const prefix = currentFolder ? currentFolder + '/' : '';
  function includeFolder(path) {
    if (query) {
      const segments = path.split('/');
      for (const [index, segment] of segments.entries()) {
        if (segment && segment.toLowerCase().includes(query)) folders.add(segments.slice(0, index + 1).join('/'));
      }
    } else if (path !== currentFolder && path.startsWith(prefix)) {
      folders.add(prefix + path.slice(prefix.length).split('/')[0]);
    }
  }
  if (!showingBin) savedFolders.forEach(includeFolder);
  for (const file of files) {
    if (Boolean(file.trashed) !== showingBin) continue;
    const path = file.folder || '';
    if (query ? (path + '/' + file.name).toLowerCase().includes(query) : path === currentFolder) {
      visibleFiles.push(file);
    }
    includeFolder(path);
  }

  const available = files.filter(file => Boolean(file.trashed) === showingBin);
  const availableKeys = new Set(available.map(fileKey));
  for (const key of selectedFiles) {
    if (!availableKeys.has(key)) selectedFiles.delete(key);
  }
  selectionCards = [];

  const folderRows = [...folders].sort().map(path => {
    const name = path.split('/').at(-1);
    const button = document.createElement('span');
    button.className = 'folder-name';
    button.textContent = name;
    button.prepend(typeIcon('folder'));
    button.title = path;
    const item = document.createElement('li');
    item.className = 'folder-item';
    const cover = document.createElement('div');
    cover.className = 'folder-cover';
    cover.append(typeIcon('folder'));
    item.append(cover);
    const actions = [['Open', () => openFolder(path)]];
    if (showingBin) {
      actions.push(['Restore folder contents', () => changeFolder(path, 'restore')],
        ['Delete folder contents permanently', () => changeFolder(path, 'delete')]);
    } else {
      actions.push(
        ['Download ZIP', () => downloadZip(folderFiles(path))],
        ['Rename', () => updateFolder(path, 'rename')],
        ['Make a copy', () => updateFolder(path, 'copy')],
        ['Share', () => updateFolder(path, 'share')],
        ['Move folder contents to bin', () => changeFolder(path, 'trash')]
      );
    }
    item.append(button, actionsMenu(name, actions));
    setupSelectionCard(item, 'folder:' + path, name, available.filter(file =>
      file.folder === path || file.folder?.startsWith(path + '/')), action => updateFolder(path, action), () => openFolder(path));
    folderDropTarget(item, path);
    item.ondblclick = event => {
      if (!mobileLayout.matches && !event.target.closest('.item-actions')) openFolder(path);
    };
    return item;
  });
  const fileRows = visibleFiles.map(file => {
    const [kind, icon] = fileKind(file);
    const id = file.split ? encodeURIComponent(file.id)
      : encodeURIComponent(file.account.id) + '/' + encodeURIComponent(file.id);
    const download = (file.split ? '/api/split-download/' : '/api/download/') + id;
    const actions = showingBin ? [
      ...(file.purging ? [] : [['Restore', () => changeFile(file, 'restore')]]),
      ['Delete permanently', () => changeFile(file, 'delete')]
    ] : [
      ['Preview', () => openPreview(file)],
      ['Rename', () => changeFile(file, 'rename')],
      ['Download', () => window.location.assign(download)],
      ['Make a copy', () => changeFile(file, 'copy')],
      ['Share', () => changeFile(file, 'share')],
      ['Move to bin', () => changeFile(file, 'trash')]
    ];
    const account = file.split ? (file.driveEmails || []).join(', ') || 'Multiple Drives' : file.account.email;
    const item = row(kind === 'Image' ? file.name : icon + ' ' + file.name, account, actionsMenu(file.name, actions));
    item.className = 'file-item';
    const nameLabel = item.querySelector('strong');
    nameLabel.className = 'file-name';
    nameLabel.parentElement.classList.add('file-label');
    nameLabel.title = file.name;
    const footer = item.querySelector('small');
    footer.className = 'file-owner';
    footer.title = account;
    footer.replaceChildren();
    const initial = document.createElement('span');
    initial.className = 'owner-initial';
    initial.setAttribute('aria-hidden', 'true');
    initial.textContent = account.charAt(0).toUpperCase();
    const email = document.createElement('span');
    email.className = 'owner-email';
    email.textContent = account;
    footer.append(initial, email);
    item.append(footer);
    const uploaded = document.createElement('time');
    uploaded.className = 'file-uploaded-date';
    const created = file.createdTime ? new Date(file.createdTime) : null;
    if (created && !Number.isNaN(created.getTime())) {
      uploaded.dateTime = created.toISOString();
      uploaded.textContent = new Intl.DateTimeFormat(undefined, {
        day: 'numeric', month: 'short', year: 'numeric'
      }).format(created);
      uploaded.title = 'Uploaded ' + created.toLocaleString();
      uploaded.setAttribute('aria-label', uploaded.title);
    } else {
      uploaded.textContent = '—';
      uploaded.setAttribute('aria-label', 'Upload date unavailable');
    }
    item.append(uploaded);
    if (kind === 'Image') nameLabel.prepend(typeIcon('image'));
    setupSelectionCard(item, fileKey(file), file.name, [file], action => changeFile(file, action), () => openPreview(file));
    item.ondblclick = event => {
      if (!mobileLayout.matches && !event.target.closest('.item-actions')) void openPreview(file);
    };
    item.addEventListener('keydown', event => {
      if (event.target === item && event.key === 'Enter') void openPreview(file);
    });
    const cover = document.createElement('div');
    cover.className = 'file-preview file-cover';
    cover.setAttribute('aria-hidden', 'true');
    const format = document.createElement('span');
    format.textContent = file.name.includes('.') ? file.name.split('.').at(-1).toUpperCase().slice(0, 5) : 'FILE';
    cover.append(format);
    if (!showingBin && file.hasThumbnail) {
      const preview = document.createElement('img');
      preview.className = 'file-preview';
      preview.alt = '';
      preview.loading = 'lazy';
      preview.onerror = () => preview.replaceWith(cover);
      preview.src = '/api/thumbnail/' + id;
      item.prepend(preview);
    } else {
      item.prepend(cover);
    }
    return item;
  });
  byId('folders').replaceChildren(...folderRows);
  list.replaceChildren(...fileRows);
  byId('folder-section').hidden = !folderRows.length;
  byId('file-section').hidden = !fileRows.length;
  syncSelection();
  const empty = byId('empty');
  empty.hidden = folderRows.length + fileRows.length > 0;
  empty.textContent = query ? 'No matching files or folders.' : showingBin ? 'No items in this part of the bin.' : 'No files uploaded here yet.';
}

byId('search').oninput = renderFiles;

function sendFile(file, folder, completed, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + new URLSearchParams({ name: file.name, folder, type: file.type }));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) updateUploadProgress((completed + event.loaded) / total * 100);
    };
    xhr.onload = () => {
      if (xhr.status === 201) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || 'Upload could not complete.'));
    };
    xhr.onerror = () => reject(new Error('Connection lost. Refresh to check your files before retrying.'));
    xhr.send(file);
  });
}

byId('new-folder').onclick = async () => {
  byId('upload-actions').open = false;
  const name = window.prompt('New folder name')?.trim();
  if (!name) return;
  if (name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) {
    return message('Enter a folder name without slashes or control characters.');
  }
  const path = [currentFolder, name].filter(Boolean).join('/');
  try {
    await read('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    if (!savedFolders.includes(path)) savedFolders.push(path);
    renderFiles();
    message('Folder created.');
  } catch (error) {
    message(error.message);
  }
};

const moveDialog = byId('move-dialog');
const moveDestination = byId('move-destination');
byId('move-selected').onclick = () => {
  const paths = new Set(['']);
  for (const folder of [...savedFolders, ...files.filter(file => !file.trashed).map(file => file.folder || '')]) {
    const parts = folder.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  moveDestination.replaceChildren(...[...paths].sort().map(path =>
    new Option(path ? 'Your files › ' + path.split('/').join(' › ') : 'Your files', path)));
  moveDestination.value = currentFolder;
  moveDialog.showModal();
};
byId('confirm-move').onclick = async () => {
  const folder = moveDestination.value;
  const items = files.filter(file => !file.trashed && selectedFiles.has(fileKey(file)) &&
    (file.folder || '') !== folder);
  moveDialog.close();
  if (!items.length) return;
  bulkBusy = true;
  syncSelection();
  let moved = 0;
  const errors = [];
  try {
    for (const file of items) {
      try {
        await runFileAction(file, 'move', { folder });
        file.folder = folder;
        selectedFiles.delete(fileKey(file));
        moved++;
      } catch (error) {
        errors.push(file.name + ': ' + error.message);
      }
    }
    renderFiles();
    await refreshAfterChange().catch(error => errors.push(error.message));
    message(moved + ' of ' + items.length + ' files moved.' + (errors.length ? ' ' + errors.join(' · ') : ''));
  } finally {
    bulkBusy = false;
    syncSelection();
  }
};

for (const layout of ['list', 'grid']) {
  byId(layout + '-layout').onclick = () => {
    fileLayout = layout;
    try { localStorage.setItem('drivepool-view', layout); } catch {}
    renderFiles();
  };
}
const uploadDialog = byId('mobile-upload-dialog');
byId('mobile-new').onclick = () => {
  if (!upload.disabled && !showingBin) uploadDialog.showModal();
};
for (const button of uploadDialog.querySelectorAll('[data-upload-action]')) {
  button.onclick = () => {
    uploadDialog.close();
    byId(button.dataset.uploadAction).click();
  };
}
byId('bottom-files').onclick = () => byId('show-library').click();
byId('bottom-trash').onclick = () => byId('show-bin').click();

const navigation = byId('mobile-navigation');
const sidebar = byId('workspace-sidebar');
const mobileLayout = window.matchMedia('(max-width: 760px)');
function placeSidebar() {
  for (const { card } of selectionCards) card.draggable = !showingBin && !mobileLayout.matches;
  if (navigation.open) navigation.close();
  if (mobileLayout.matches) {
    byId('mobile-sidebar-slot').append(sidebar);
    byId('sidebar-settings').append(byId('app-settings'));
  } else {
    byId('library').prepend(sidebar);
    document.querySelector('.top').append(byId('app-settings'));
  }
}
placeSidebar();
mobileLayout.addEventListener('change', placeSidebar);
byId('mobile-menu').onclick = () => navigation.showModal();
byId('bottom-storage').onclick = () => {
  byId('sidebar-storage').hidden = false;
  byId('open-storage').setAttribute('aria-expanded', 'true');
  navigation.showModal();
  byId('open-storage').focus();
};
navigation.addEventListener('click', event => {
  if (event.target !== navigation) return;
  const bounds = navigation.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) navigation.close();
});
for (const id of ['show-library', 'show-bin', 'choose', 'choose-folder']) {
  byId(id).addEventListener('click', () => { if (navigation.open) navigation.close(); });
}
byId('open-storage').onclick = () => {
  const details = byId('sidebar-storage');
  details.hidden = !details.hidden;
  byId('open-storage').setAttribute('aria-expanded', String(!details.hidden));
};

byId('refresh').onclick = () => refresh().catch(error => message(error.message));
function openUploadPicker(input) {
  byId('upload-actions').open = false;
  input.click();
}
upload.onclick = () => openUploadPicker(chooser);
const uploadMenu = byId('upload-actions');
document.addEventListener('click', event => {
  if (!uploadMenu.contains(event.target)) uploadMenu.open = false;
});
uploadMenu.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !uploadMenu.open) return;
  uploadMenu.open = false;
  uploadMenu.querySelector('summary').focus();
});
const folderChooser = byId('folder');
const uploadFolder = byId('choose-folder');
uploadFolder.onclick = () => openUploadPicker(folderChooser);

const uploadStatus = byId('upload-status');
const uploadPercent = byId('upload-percent');
const library = byId('library');

function updateUploadProgress(value) {
  progress.value = value;
  uploadPercent.textContent = Math.floor(value) + '%';
}

function isFileDrag(event) {
  return event.dataTransfer?.types.includes('Files');
}

for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, event => {
    if (isFileDrag(event)) event.preventDefault();
  });
}

library.addEventListener('dragover', event => {
  if (!isFileDrag(event) || showingBin || upload.disabled) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  library.classList.add('file-drag-active');
});
library.addEventListener('dragleave', event => {
  if (!library.contains(event.relatedTarget)) library.classList.remove('file-drag-active');
});
library.addEventListener('drop', event => {
  library.classList.remove('file-drag-active');
  if (!isFileDrag(event) || showingBin || upload.disabled) return;
  event.preventDefault();
  const items = Array.from(event.dataTransfer.items);
  const folders = new Set(items.filter(item => item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()?.name));
  const dropped = Array.from(event.dataTransfer.files).filter(file => !folders.has(file.name));
  if (!dropped.length && folders.size) message('Use + New → Upload folder for folders.');
  void uploadFiles(dropped);
});

async function uploadFiles(selected) {
  if (!selected.length || upload.disabled || showingBin) return;
  upload.disabled = uploadFolder.disabled = true;
  updateUploadProgress(0);
  uploadStatus.hidden = false;
  const total = selected.reduce((sum, file) => sum + file.size, 0) || 1;
  const destinationFolder = currentFolder;
  const failures = [];
  let completed = 0;
  let count = 0;
  let result;
  try {
    for (const [index, file] of selected.entries()) {
      const relativeFolder = (file.webkitRelativePath || '').split('/').slice(0, -1).join('/');
      const folder = [destinationFolder, relativeFolder].filter(Boolean).join('/');
      byId('upload-current').textContent = 'Uploading ' + (index + 1) + ' of ' + selected.length + ' · ' + file.name;
      try {
        result = await sendFile(file, folder, completed, total);
        count++;
      } catch (error) {
        failures.push(file.name + ': ' + error.message);
      }
      completed += file.size;
      updateUploadProgress(completed / total * 100);
    }
    const summary = failures.length
      ? count + ' of ' + selected.length + ' files saved. ' + failures.join(' · ')
      : count > 1 ? count + ' files saved.'
        : result.split ? 'Saved across ' + result.parts + ' Drives. Download returns the original file.'
          : 'Saved to ' + result.account + '.';
    try {
      await refreshAfterChange();
      message(summary);
    } catch (error) {
      message(summary + ' Could not refresh the file list. ' + error.message);
    }
  } finally {
    upload.disabled = uploadFolder.disabled = false;
    uploadStatus.hidden = true;
  }
}

chooser.onchange = folderChooser.onchange = event => {
  const input = event.currentTarget;
  const selected = Array.from(input.files);
  input.value = '';
  void uploadFiles(selected);
};

let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
const install = byId('install');
const standalone = window.matchMedia('(display-mode: standalone)');
install.hidden = standalone.matches || navigator.standalone === true;
window.addEventListener('appinstalled', () => { install.hidden = true; });
install.onclick = async () => {
  if (!installPrompt) return byId('install-guide').showModal();
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

try {
  const { configured, signedIn } = await read('/api/session');
  const connect = byId('connect');
  connect.disabled = !configured;
  connect.onclick = async () => {
    connect.disabled = true;
    message('Opening Google sign-in…');
    try {
      const { authorizationUrl } = await read('/oauth/start', { method: 'POST' });
      window.location.assign(authorizationUrl);
    } catch (error) {
      message(error.message);
      connect.disabled = false;
    }
  };
  connect.textContent = signedIn ? 'Connect another Google Drive' : 'Connect Google Drive';
  const outcome = new URLSearchParams(location.search).get('connection');
  if (!configured) message('Google OAuth setup is required. Follow the project README to connect accounts.');
  else if (outcome === 'cancelled') message('Google account connection was cancelled.');
  else if (outcome) {
    const hints = {
      drive_permission: 'Select the Google Drive permission on the consent screen, then continue.',
      invalid_client: 'Check that the Client ID and Client Secret in .env belong to the same Google OAuth web client.',
      unauthorized_client: 'Check that your OAuth client is a Web application and the callback URL is registered.',
      invalid_grant: 'Start a fresh sign-in from Drivepool. If it repeats, check the authorized callback URL.',
      token_exchange: 'The server could not complete the token exchange with Google. Check its internet connection and try again.',
      identity: 'Google could not confirm your account identity. Retry and allow email access if asked.',
      offline_access: 'Google did not grant Drivepool offline access. Start a fresh connection and approve the requested access.',
      save_connection: 'Drivepool could not save the connection. Check that the server can write to its data directory.'
    };
    if (Object.hasOwn(hints, outcome)) message(hints[outcome] + ' (' + outcome + ')');
    else message('Could not connect the account. Please try again.');
  }
  if (outcome) history.replaceState(null, '', '/');
  byId('logout').hidden = !signedIn;
  byId('header-search').hidden = !signedIn;
  byId('welcome').hidden = signedIn;
  if (signedIn) {
    byId('sidebar-connect').append(connect);
    byId('mobile-menu').hidden = false;
    byId('mobile-bottom-nav').hidden = false;
    byId('mobile-new').hidden = false;
  }
  byId('library').hidden = !signedIn;
  document.body.classList.toggle('signed-in', signedIn);
  if (signedIn) await refresh();
} catch (error) {
  message(error.message);
}
