const byId = id => document.getElementById(id);
const themeSelect = byId('theme-select');
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeColors = new Map([
  ['studio', '#f3f5fc'],
  ['amber', '#f8f4eb'],
  ['ocean', '#f1f7ff'],
  ['lavender', '#f7f3fc'],
  ['classic-green', '#f4f7f1'],
  ['classic-blue', '#f8fafd'],
  ['forest-lime', '#f3f6ef']
]);

function applyTheme(theme) {
  const selected = themeColors.has(theme) ? theme : 'classic-blue';
  document.documentElement.dataset.theme = selected;
  themeSelect.value = selected;
  document.querySelector('.brand img').src =
    selected === 'forest-lime' ? '/icon-forest.png' : '/icon-192.png?v=3';
  themeColor.content = themeColors.get(selected);
}

let savedTheme;
try { savedTheme = localStorage.getItem('drivepool-theme'); } catch {}
applyTheme(savedTheme);

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
    const { accounts, splitFiles = [] } = await read('/api/dashboard');
    if (request !== dashboardRequest) return;
    const measured = accounts.filter(account => account.free != null);
    byId('free-label').textContent = measured.length === accounts.length ? 'Total free space' : 'Known free space';
    byId('free').textContent = measured.length ? bytes(measured.reduce((sum, account) => sum + account.free, 0)) : '—';
    byId('largest').textContent = measured.length ? bytes(measured.reduce((sum, account) => sum + account.max, 0)) : '—';
    byId('count').textContent = accounts.length;
    byId('accounts').replaceChildren(...accounts.map(account =>
      row(account.email, account.unavailable ? 'Some account data is unavailable. Refresh or reconnect.' : 'Google Drive',
        storageBadge(account.free))
    ));
    files = [...splitFiles, ...accounts.flatMap(account => account.files.map(file => ({ ...file, account })))]
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
    renderFiles();
  } finally {
    if (request === dashboardRequest) button.disabled = false;
  }
}

let files = [];
let showingBin = false;
let bulkBusy = false;
const selectedFiles = new Set();
let visibleSelectionFiles = [];
let selectionCheckboxes = [];
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
  byId('library-title').textContent = value ? 'Bin' : 'Your files';
  byId('library-description').textContent = value
    ? 'Restore files to their original folder or delete them permanently.'
    : 'Drop files here or use + New to upload.';
  byId('upload-actions').hidden = value;
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
  for (const { checkbox, keys } of selectionCheckboxes) {
    const count = keys.filter(key => selectedFiles.has(key)).length;
    checkbox.checked = count === keys.length;
    checkbox.indeterminate = count > 0 && count < keys.length;
    checkbox.disabled = bulkBusy;
  }
  const allVisibleSelected = visibleSelectionFiles.length > 0 &&
    visibleSelectionFiles.every(file => selectedFiles.has(fileKey(file)));
  byId('selection-actions').hidden = !selected.length;
  byId('bin-tools').hidden = !showingBin;
  byId('select-all-files').textContent = allVisibleSelected ? 'Deselect all' : 'Select all';
  byId('select-all-files').disabled = bulkBusy || !visibleSelectionFiles.length;
  byId('download-selected').hidden = showingBin;
  byId('download-selected').disabled = bulkBusy || !selected.length;
  byId('move-selected-to-bin').hidden = showingBin;
  byId('move-selected-to-bin').disabled = bulkBusy || !selected.length;
  for (const id of ['restore-selected', 'delete-selected', 'empty-bin']) byId(id).hidden = !showingBin;
  byId('restore-selected').disabled = bulkBusy || !selected.length || selected.some(file => file.purging);
  byId('delete-selected').disabled = bulkBusy || !selected.length;
  byId('empty-bin').disabled = bulkBusy || !available.length;
  byId('bin-selection-count').textContent = selected.length + ' selected';
}

function selectionCheckbox(rowKey, name, items) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'bin-checkbox';
  checkbox.setAttribute('aria-label', 'Select ' + name);
  const keys = items.map(fileKey);
  selectionCheckboxes.push({ checkbox, keys, rowKey });
  checkbox.onclick = event => {
    const clicked = selectionCheckboxes.findIndex(row => row.rowKey === rowKey);
    const anchor = selectionCheckboxes.findIndex(row => row.rowKey === selectionAnchor);
    const range = event.shiftKey && anchor !== -1
      ? selectionCheckboxes.slice(Math.min(anchor, clicked), Math.max(anchor, clicked) + 1)
      : [selectionCheckboxes[clicked]];
    for (const row of range) {
      for (const key of row.keys) {
        if (checkbox.checked) selectedFiles.add(key);
        else selectedFiles.delete(key);
      }
    }
    selectionAnchor = rowKey;
    syncSelection();
  };
  return checkbox;
}

byId('select-all-files').onclick = () => {
  const keys = visibleSelectionFiles.map(fileKey);
  const clear = keys.every(key => selectedFiles.has(key));
  for (const key of keys) {
    if (clear) selectedFiles.delete(key);
    else selectedFiles.add(key);
  }
  syncSelection();
};

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

byId('download-selected').onclick = () => downloadZip(files.filter(file =>
  !file.trashed && selectedFiles.has(fileKey(file))));

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
  list.dataset.view = 'grid';
  byId('folders').dataset.view = 'grid';

  const breadcrumbs = byId('breadcrumbs');
  breadcrumbs.replaceChildren();
  const parts = currentFolder ? currentFolder.split('/') : [];
  for (const [index, name] of [showingBin ? 'Bin' : 'All files', ...parts].entries()) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => openFolder(parts.slice(0, index).join('/'));
    breadcrumbs.append(button);
  }

  const folders = new Set();
  const visibleFiles = [];
  const prefix = currentFolder ? currentFolder + '/' : '';
  for (const file of files) {
    if (Boolean(file.trashed) !== showingBin) continue;
    const path = file.folder || '';
    if (query) {
      if ((path + '/' + file.name).toLowerCase().includes(query)) visibleFiles.push(file);
      const segments = path.split('/');
      for (const [index, segment] of segments.entries()) {
        if (segment && segment.toLowerCase().includes(query)) folders.add(segments.slice(0, index + 1).join('/'));
      }
    } else if (path === currentFolder) {
      visibleFiles.push(file);
    } else if (path.startsWith(prefix)) {
      folders.add(prefix + path.slice(prefix.length).split('/')[0]);
    }
  }

  const available = files.filter(file => Boolean(file.trashed) === showingBin);
  const availableKeys = new Set(available.map(fileKey));
  for (const key of selectedFiles) {
    if (!availableKeys.has(key)) selectedFiles.delete(key);
  }
  selectionCheckboxes = [];
  visibleSelectionFiles = available.filter(file =>
    visibleFiles.includes(file) || (file.folder || '').split('/').some((_, index, segments) =>
      folders.has(segments.slice(0, index + 1).join('/'))));

  const folderRows = [...folders].sort().map(path => {
    const name = path.split('/').at(-1);
    const button = document.createElement('button');
    button.className = 'folder-name';
    button.textContent = name;
    button.prepend(typeIcon('folder'));
    button.title = path;
    button.onclick = () => openFolder(path);
    const item = document.createElement('li');
    item.className = 'folder-item';
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
    item.prepend(selectionCheckbox('folder:' + path, 'folder ' + path, available.filter(file =>
      file.folder === path || file.folder?.startsWith(path + '/'))));
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
    nameLabel.title = file.name;
    if (kind === 'Image') nameLabel.prepend(typeIcon('image'));
    item.prepend(selectionCheckbox(fileKey(file), file.name, [file]));
    if (!showingBin && file.hasThumbnail) {
      const preview = document.createElement('img');
      preview.className = 'file-preview';
      preview.alt = '';
      preview.loading = 'lazy';
      preview.onerror = () => preview.remove();
      preview.src = '/api/thumbnail/' + id;
      item.prepend(preview);
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

const storageDrawer = byId('storage-drawer');
byId('open-storage').onclick = () => storageDrawer.showModal();

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
  if (signedIn) byId('dashboard').after(connect);
  byId('library').hidden = !signedIn;
  document.body.classList.toggle('signed-in', signedIn);
  if (signedIn) await refresh();
} catch (error) {
  message(error.message);
}
