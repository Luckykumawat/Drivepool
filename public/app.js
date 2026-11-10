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
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, size)) / 10));
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
    .format(size / 1024 ** unit) + ' ' + units[unit];
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

async function refresh() {
  const button = byId('refresh');
  button.disabled = true;
  try {
    const { accounts } = await read('/api/dashboard');
    const measured = accounts.filter(account => account.free != null);
    byId('free-label').textContent = measured.length === accounts.length ? 'Total free space' : 'Known free space';
    byId('free').textContent = measured.length ? bytes(measured.reduce((sum, account) => sum + account.free, 0)) : '—';
    byId('largest').textContent = measured.length ? bytes(Math.max(...measured.map(account => account.max))) : '—';
    byId('count').textContent = accounts.length;
    byId('accounts').replaceChildren(...accounts.map(account =>
      row(account.email, account.unavailable ? 'Some account data is unavailable. Refresh or reconnect.' : 'Google Drive',
        document.createTextNode(account.free == null ? '—' : bytes(account.free) + ' free'))
    ));
    const files = accounts.flatMap(account => account.files.map(file => ({ ...file, account })))
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
    byId('files').replaceChildren(...files.map(file => {
      const link = document.createElement('a');
      link.className = 'download';
      link.href = '/api/download/' + encodeURIComponent(file.account.id) + '/' + encodeURIComponent(file.id);
      link.textContent = 'Download';
      link.setAttribute('aria-label', 'Download ' + file.name);
      return row(file.name, bytes(file.size) + ' · ' + file.account.email, link);
    }));
    byId('empty').hidden = files.length > 0;
  } finally {
    button.disabled = false;
  }
}

function sendFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + new URLSearchParams({ name: file.name }));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress.value = event.loaded / event.total * 100;
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
chooser.onchange = async () => {
  const [file] = chooser.files;
  if (!file) return;
  upload.disabled = true;
  progress.value = 0;
  progress.hidden = false;
  message('Uploading ' + file.name + '…');
  try {
    const result = await sendFile(file);
    message('Saved to ' + result.account + '.');
    await refresh();
  } catch (error) {
    message(error.message);
  } finally {
    chooser.value = '';
    upload.disabled = false;
    progress.hidden = true;
  }
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
  byId('dashboard').hidden = !signedIn;
  if (signedIn) await refresh();
} catch (error) {
  message(error.message);
}
