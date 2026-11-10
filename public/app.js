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

function renderFiles() {
  const query = byId('search').value.trim().toLowerCase();
  const list = byId('files');
  list.dataset.view = view;
  byId('list-view').setAttribute('aria-pressed', String(view === 'list'));
  byId('grid-view').setAttribute('aria-pressed', String(view === 'grid'));

  const breadcrumbs = byId('breadcrumbs');
  breadcrumbs.replaceChildren();
  const parts = currentFolder ? currentFolder.split('/') : [];
  for (const [index, name] of ['All files', ...parts].entries()) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => openFolder(parts.slice(0, index).join('/'));
    breadcrumbs.append(button);
  }

  const folders = new Set();
  const visibleFiles = [];
  const prefix = currentFolder ? currentFolder + '/' : '';
  for (const file of files) {
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
    const button = document.createElement('button');
    button.textContent = 'Open';
    button.setAttribute('aria-label', 'Open folder ' + path);
    button.onclick = () => openFolder(path);
    return row('📁 ' + path.split('/').at(-1), query ? 'Folder · ' + path : 'Folder', button);
  });
  const fileRows = visibleFiles.map(file => {
    const [kind, icon] = fileKind(file);
    const id = file.split ? encodeURIComponent(file.id)
      : encodeURIComponent(file.account.id) + '/' + encodeURIComponent(file.id);
    const link = document.createElement('a');
    link.className = 'download';
    link.href = (file.split ? '/api/split-download/' : '/api/download/') + id;
    link.textContent = 'Download';
    link.setAttribute('aria-label', 'Download ' + file.name);
    const detail = [kind, bytes(file.size), file.split ? file.partCount + ' Drives' : file.account.email, query && file.folder].filter(Boolean).join(' · ');
    const item = row(icon + ' ' + file.name, detail, link);
    if (view === 'grid' && file.hasThumbnail) {
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
  list.replaceChildren(...folderRows, ...fileRows);
  const empty = byId('empty');
  empty.hidden = folderRows.length + fileRows.length > 0;
  empty.textContent = query ? 'No matching files or folders.' : 'No files uploaded here yet.';
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
