const byId = id => document.getElementById(id);
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

async function refresh() {
  const button = byId('refresh');
  button.disabled = true;
  try {
    const { accounts, splitFiles = [] } = await read('/api/dashboard');
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
    button.disabled = false;
  }
}

let files = [];
let showingBin = false;
let currentFolder = '';
let view = 'grid';
try {
  if (localStorage.getItem('drivepool-view') === 'list') view = 'list';
} catch {}

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
  await refresh().catch(error => message(error.message));
}

async function changeFolder(path, action) {
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
  await refresh().catch(error => message(error.message));
}

function showBin(value) {
  showingBin = value;
  byId('show-library').setAttribute('aria-pressed', String(!value));
  byId('show-bin').setAttribute('aria-pressed', String(value));
  byId('library-title').textContent = value ? 'Bin' : 'Your files';
  byId('library-description').textContent = value
    ? 'Restore files to their original folder or delete them permanently.'
    : 'Manage files from all your connected Drives.';
  byId('upload-actions').hidden = value;
  openFolder('');
}

byId('show-library').onclick = () => showBin(false);
byId('show-bin').onclick = () => showBin(true);

function renderFiles() {
  const query = byId('search').value.trim().toLowerCase();
  const list = byId('files');
  list.dataset.view = view;
  byId('folders').dataset.view = view;
  byId('list-view').setAttribute('aria-pressed', String(view === 'list'));
  byId('grid-view').setAttribute('aria-pressed', String(view === 'grid'));

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

  const folderRows = [...folders].sort().map(path => {
    const name = path.split('/').at(-1);
    const button = document.createElement('button');
    button.className = 'folder-name';
    button.textContent = '📁 ' + name;
    button.title = path;
    button.onclick = () => openFolder(path);
    const item = document.createElement('li');
    item.className = 'folder-item';
    const actions = [['Open', () => openFolder(path)]];
    if (showingBin) {
      actions.push(['Restore folder contents', () => changeFolder(path, 'restore')],
        ['Delete folder contents permanently', () => changeFolder(path, 'delete')]);
    } else {
      actions.push(['Move folder contents to bin', () => changeFolder(path, 'trash')]);
    }
    item.append(button, actionsMenu(name, actions));
    return item;
  });
  const fileRows = visibleFiles.map(file => {
    const [, icon] = fileKind(file);
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
    const item = row(icon + ' ' + file.name, account, actionsMenu(file.name, actions));
    item.className = 'file-item';
    if (!showingBin && view === 'grid' && file.hasThumbnail) {
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
  const empty = byId('empty');
  empty.hidden = folderRows.length + fileRows.length > 0;
  empty.textContent = query ? 'No matching files or folders.' : showingBin ? 'No items in this part of the bin.' : 'No files uploaded here yet.';
}

byId('search').oninput = renderFiles;
for (const layout of ['grid', 'list']) {
  byId(layout + '-view').onclick = () => {
    view = layout;
    try { localStorage.setItem('drivepool-view', view); } catch {}
    renderFiles();
  };
}

function sendFile(file, folder, completed, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + new URLSearchParams({ name: file.name, folder, type: file.type }));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress.value = (completed + event.loaded) / total * 100;
    };
    xhr.onload = () => {
      if (xhr.status === 201) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || 'Upload could not complete.'));
    };
    xhr.onerror = () => reject(new Error('Connection lost. Refresh to check your files before retrying.'));
    xhr.send(file);
  });
}

byId('refresh').onclick = () => refresh().catch(error => message(error.message));
upload.onclick = () => chooser.click();
const folderChooser = byId('folder');
const uploadFolder = byId('choose-folder');
uploadFolder.onclick = () => folderChooser.click();

async function uploadSelection(event) {
  const input = event.currentTarget;
  const selected = Array.from(input.files);
  if (!selected.length) return;
  upload.disabled = uploadFolder.disabled = true;
  progress.value = 0;
  progress.hidden = false;
  const total = selected.reduce((sum, file) => sum + file.size, 0) || 1;
  const destinationFolder = currentFolder;
  let completed = 0;
  let count = 0;
  let result;
  let uploadError;
  try {
    for (const file of selected) {
      const relativeFolder = file.webkitRelativePath.split('/').slice(0, -1).join('/');
      const folder = [destinationFolder, relativeFolder].filter(Boolean).join('/');
      message('Uploading ' + (count + 1) + ' of ' + selected.length + ' · ' + file.name + '…');
      result = await sendFile(file, folder, completed, total);
      completed += file.size;
      count++;
    }
  } catch (error) {
    uploadError = error.message;
  }
  try {
    await refresh();
    if (uploadError) message(count + ' of ' + selected.length + ' files saved. ' + uploadError);
    else if (count > 1) message(count + ' files saved.');
    else if (result.split) message('Saved across ' + result.parts + ' Drives. Download returns the original file.');
    else message('Saved to ' + result.account + '.');
  } catch (error) {
    message(count + ' files saved. Refresh failed. ' + (uploadError || error.message));
  } finally {
    input.value = '';
    upload.disabled = uploadFolder.disabled = false;
    progress.hidden = true;
  }
}
chooser.onchange = folderChooser.onchange = uploadSelection;

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
  byId('dashboard').hidden = !signedIn;
  byId('library').hidden = !signedIn;
  if (signedIn) await refresh();
} catch (error) {
  message(error.message);
}
