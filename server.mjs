import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase } from './database.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3000').origin;
const secure = origin.startsWith('https:');
const port = Number(process.env.PORT || new URL(origin).port || (secure ? 8080 : 80));
if (!secure && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) {
  throw new Error('Use an HTTPS APP_ORIGIN outside localhost.');
}
const callback = origin + '/oauth/callback';
const client_id = process.env.GOOGLE_CLIENT_ID;
const client_secret = process.env.GOOGLE_CLIENT_SECRET;
const key = Buffer.from(process.env.TOKEN_KEY || '', 'base64');
const configured = Boolean(client_id && client_secret && key.length === 32);
process.umask(0o077);
if (process.env.RENDER && (!process.env.DATABASE_URL || !secure || !configured)) {
  throw new Error('Render requires DATABASE_URL, an HTTPS APP_ORIGIN and Google OAuth credentials.');
}
const query = await openDatabase(process.env.DATABASE_URL);
const hash = value => createHash('sha256').update(value).digest('base64url');
const nonce = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const driveApi = 'https://www.googleapis.com/drive/v3';
const scope = 'https://www.googleapis.com/auth/drive.file';
const pending = new Map();
const properties = user => ({ drivepoolOwner: user });

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unseal(value) {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function session(req) {
  const value = req.headers.cookie?.match(/(?:^|;\s*)dp_session=([\w-]{43})(?:;|$)/)?.[1];
  if (value) {
    const [current] = await query('SELECT * FROM @sessions WHERE id=? AND expiry>?', hash(value), now());
    return current;
  }
}

async function newSession(res, user = null, previousId = null) {
  const value = nonce();
  const id = hash(value);
  const seconds = user ? 604800 : 600;
  await query('INSERT INTO @sessions VALUES (?,?,?)', id, user, now() + seconds * 1000);
  await query('DELETE FROM @sessions WHERE expiry<=? OR id=?', now(), previousId);
  res.setHeader('Set-Cookie', `dp_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
  return { id, user_id: user };
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location }).end();
}

async function google(url, options) {
  return fetch(url, { ...options, redirect: 'error', signal: options?.signal ?? AbortSignal.timeout(25000) });
}

async function exchange(fields) {
  const response = await google('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id, client_secret, ...fields })
  });
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    const reason = ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(error) ? error : 'token_exchange';
    throw Object.assign(new Error('Google authorization failed. Please reconnect the account.'), { status: 502, reason });
  }
  return response.json();
}

async function access(connection) {
  return (await exchange({ grant_type: 'refresh_token', refresh_token: unseal(connection.token) })).access_token;
}

async function quota(token) {
  const response = await google(driveApi + '/about?fields=storageQuota,maxUploadSize', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!response.ok) fail(502, 'Could not read Drive storage.');
  const { storageQuota = {}, maxUploadSize } = await response.json();
  const free = storageQuota.limit != null && storageQuota.usage != null
    ? Math.max(0, Number(storageQuota.limit) - Number(storageQuota.usage)) : null;
  return { free, max: Math.min(free ?? 0, Number(maxUploadSize ?? Infinity)) };
}

async function listFiles(token, user) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `trashed = false and appProperties has { key='drivepoolOwner' and value='${user}' }`,
      fields: 'nextPageToken,files(id,name,size,createdTime,mimeType,description,hasThumbnail)', pageSize: '100'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await google(driveApi + '/files?' + params, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!response.ok) fail(502, 'Could not list Drive files.');
    const page = await response.json();
    files.push(...page.files.map(({ description, ...file }) => ({
      ...file,
      folder: description?.startsWith('Drivepool folder: ') ? description.slice(18) : ''
    })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function upload(req, res, url, user, connections) {
  const name = url.searchParams.get('name')?.trim();
  const folder = url.searchParams.get('folder') || '';
  if (folder.length > 1000 || folder.split('/').some(part => part === '.' || part === '..') ||
      /[\x00-\x1f\x7f]/.test(folder)) fail(400, 'Invalid folder path.');
  const type = url.searchParams.get('type') || '';
  const mime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(type) &&
    !type.toLowerCase().startsWith('application/vnd.google-apps.')
    ? type : 'application/octet-stream';
  const size = Number(req.headers['content-length']);
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name) ||
      !Number.isSafeInteger(size) || size < 0) fail(400, 'A valid file name and size are required.');

  const results = await Promise.allSettled(connections.map(async connection => {
    const token = await access(connection);
    return { connection, token, ...await quota(token) };
  }));
  const candidates = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const available = candidate => candidate.max - (pending.get(candidate.connection.subject) || 0);
  const selected = candidates.filter(candidate => candidate.free !== null && available(candidate) >= size)
    .sort((a, b) => available(b) - available(a))[0];
  if (!selected) fail(409, 'No connected Drive with known free space can fit this file.');

  const { connection, token } = selected;
  pending.set(connection.subject, (pending.get(connection.subject) || 0) + size);
  try {
    const start = await google('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mime
      },
      body: JSON.stringify({ name, appProperties: properties(user), ...(folder && { description: 'Drivepool folder: ' + folder }) })
    });
    if (!start.ok || !start.headers.get('location')) fail(502, 'Google could not start the upload.');
    const destination = new URL(start.headers.get('location'));
    if (destination.origin !== 'https://www.googleapis.com') fail(502, 'Unexpected Drive upload location.');
    const abort = new AbortController();
    const uploadTimeout = AbortSignal.timeout(60 * 60 * 1000);
    const cancel = () => abort.abort();
    res.once('close', cancel);
    try {
      const finish = await google(destination, {
        method: 'PUT', signal: AbortSignal.any([abort.signal, uploadTimeout]), duplex: 'half',
        headers: { 'Content-Length': String(size), 'Content-Type': mime },
        body: size ? req : undefined
      });
      if (!finish.ok) fail(502, 'Google could not complete the upload. Refresh and check before retrying.');
      const file = await finish.json();
      json(res, 201, { id: file.id, account: connection.email });
    } finally {
      res.off('close', cancel);
    }
  } finally {
    const remaining = pending.get(connection.subject) - size;
    if (remaining) pending.set(connection.subject, remaining);
    else pending.delete(connection.subject);
  }
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']]
].map(([route, [file, type]]) => [route, [readFileSync(new URL('./public/' + file, import.meta.url)), type]]));

createServer({ requestTimeout: 60 * 60 * 1000 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'GET' && assets.has(path)) {
      const [content, type] = assets.get(path);
      return res.writeHead(200, { 'Content-Type': type }).end(content);
    }
    if (req.method === 'POST' && req.headers.origin !== origin) fail(403, 'Invalid request origin.');
    const current = await session(req);
    if (path === '/api/session' && req.method === 'GET') {
      return json(res, 200, { signedIn: Boolean(current?.user_id), configured });
    }
    if (!configured) fail(503, 'Google OAuth is not configured. See the setup guide.');
    if (path === '/oauth/start' && req.method === 'POST') {
      const owner = current || await newSession(res);
      const state = nonce();
      const verifier = nonce();
      await query('DELETE FROM @oauth WHERE expiry<=? OR session_id=?', now(), owner.id);
      await query('INSERT INTO @oauth VALUES (?,?,?,?)', hash(state), owner.id, verifier, now() + 600000);
      const params = new URLSearchParams({
        client_id, redirect_uri: callback, response_type: 'code',
        scope: 'openid email ' + scope, state, code_challenge: hash(verifier), code_challenge_method: 'S256',
        prompt: 'consent select_account', access_type: 'offline'
      });
      return json(res, 200, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
    }
    if (path === '/oauth/callback' && req.method === 'GET') {
      if (!current) fail(400, 'Connection session expired. Start again from Drivepool.');
      const [flow] = await query('DELETE FROM @oauth WHERE state=? AND session_id=? AND expiry>? RETURNING verifier',
        hash(url.searchParams.get('state') || ''), current.id, now());
      if (!flow) fail(400, 'Connection request expired. Start again from Drivepool.');
      if (!url.searchParams.has('code')) return redirect(res, '/?connection=cancelled');
      let stage = 'token_exchange';
      try {
        const token = await exchange({
          code: url.searchParams.get('code'), grant_type: 'authorization_code',
          redirect_uri: callback, code_verifier: flow.verifier
        });
        stage = 'drive_permission';
        if (!token.scope?.split(' ').includes(scope)) fail(400, 'Drive file permission is required.');
        stage = 'identity';
        const identity = await google('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + token.access_token }
        });
        if (!identity.ok) fail(502, 'Could not identify the Google account.');
        const { sub, email, email_verified } = await identity.json();
        if (!sub || !email || !email_verified) fail(400, 'A verified Google account is required.');
        // The first account anchors the app login. Connected secondary accounts do not grant login access.
        const user = current.user_id || hash('drivepool-primary:' + sub);
        const [existing] = await query('SELECT token FROM @drives WHERE user_id=? AND subject=?', user, sub);
        stage = 'offline_access';
        if (!token.refresh_token && !existing) fail(400, 'Google did not grant offline access.');
        stage = 'save_connection';
        await query(`INSERT INTO @drives (id,user_id,subject,email,token) VALUES (?,?,?,?,?)
          ON CONFLICT(user_id,subject) DO UPDATE SET email=excluded.email,token=excluded.token`,
          randomUUID(), user, sub, email, token.refresh_token ? seal(token.refresh_token) : existing.token);
        await newSession(res, user, current.id);
        return redirect(res, '/');
      } catch (error) {
        return redirect(res, '/?connection=' + (error.reason || stage));
      }
    }
    const user = current?.user_id;
    if (!user) fail(401, 'Sign in with your primary Google account.');
    if (path === '/api/logout' && req.method === 'POST') {
      await query('DELETE FROM @sessions WHERE id=?', current.id);
      res.setHeader('Set-Cookie', 'dp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : ''));
      return redirect(res, '/');
    }
    const connections = await query('SELECT * FROM @drives WHERE user_id=? ORDER BY rowid', user);
    if (path === '/api/dashboard' && req.method === 'GET') {
      const accounts = await Promise.all(connections.map(async connection => {
        const { id, email } = connection;
        try {
          const token = await access(connection);
          const [space, files] = await Promise.allSettled([quota(token), listFiles(token, user)]);
          return {
            id, email, free: space.value?.free ?? null, max: space.value?.max ?? 0,
            files: files.value || [], unavailable: space.status === 'rejected' || files.status === 'rejected'
          };
        } catch {
          return { id, email, free: null, max: 0, files: [], unavailable: true };
        }
      }));
      return json(res, 200, { accounts });
    }
    if (path === '/api/upload' && req.method === 'POST') return await upload(req, res, url, user, connections);
    const match = path.match(/^\/api\/(download|thumbnail)\/([\w-]+)\/([\w-]+)$/);
    if (match && req.method === 'GET') {
      const connection = connections.find(account => account.id === match[2]);
      if (!connection) fail(404, 'File not found.');
      const headers = { Authorization: 'Bearer ' + await access(connection) };
      const target = driveApi + '/files/' + match[3];
      const info = await google(target + '?fields=name,appProperties,trashed,thumbnailLink', { headers });
      if (!info.ok) fail(404, 'File not available.');
      const file = await info.json();
      if (file.trashed || file.appProperties?.drivepoolOwner !== user) fail(404, 'File not found.');
      if (match[1] === 'thumbnail') {
        if (!file.thumbnailLink) fail(404, 'Preview unavailable.');
        const thumbnail = new URL(file.thumbnailLink);
        if (thumbnail.protocol !== 'https:' || thumbnail.port ||
            !thumbnail.hostname.endsWith('.googleusercontent.com')) fail(404, 'Preview unavailable.');
        const preview = await google(thumbnail, { headers });
        const contentType = preview.headers.get('content-type');
        if (!preview.ok || !preview.body || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
          await preview.body?.cancel();
          fail(404, 'Preview unavailable.');
        }
        res.writeHead(200, { 'Content-Type': contentType });
        return await pipeline(Readable.fromWeb(preview.body), res);
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const media = await google(target + '?alt=media', { headers, signal: controller.signal });
      if (!media.ok || !media.body) fail(502, 'Drive could not download this file.');
      const filename = encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': "attachment; filename*=UTF-8''" + filename
      });
      return await pipeline(Readable.fromWeb(media.body), res);
    }
    fail(404, 'Page not found.');
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 502, { error: error.status ? error.message : 'Request could not complete. Please try again.' });
  }
}).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Drivepool ready on port ${port}. Google OAuth ${configured ? 'enabled' : 'needs setup'}.`));
