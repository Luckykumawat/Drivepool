import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase } from './database.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ZipStream from 'zip-stream';

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
      q: `appProperties has { key='drivepoolOwner' and value='${user}' }`,
      fields: 'nextPageToken,files(id,name,size,createdTime,mimeType,description,hasThumbnail,trashed)', pageSize: '100'
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
  const ranked = candidates.filter(candidate => candidate.free !== null && available(candidate) >= 0)
    .sort((a, b) => available(b) - available(a));
  if (!ranked.length) fail(409, 'No connected Drive has known free space.');

  const plan = [];
  let remaining = size;
  for (const candidate of ranked) {
    const length = Math.min(remaining, available(candidate));
    if (!length && remaining) continue;
    plan.push({ ...candidate, length });
    remaining -= length;
    if (!remaining) break;
  }
  if (remaining) fail(409, 'The connected Drives do not have enough available space for this file.');

  for (const { connection, length } of plan) {
    pending.set(connection.subject, (pending.get(connection.subject) || 0) + length);
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60 * 1000)]);
  res.once('close', cancel);
  const split = plan.length > 1;
  const id = randomUUID();
  const parts = [];
  let savingManifest = false;
  const source = req.iterator({ destroyOnReturn: false });
  let buffered = Buffer.alloc(0);

  async function* take(length, checksum) {
    while (length > 0) {
      if (!buffered.length) {
        const { value, done } = await source.next();
        if (done) fail(400, 'The upload ended before all bytes arrived.');
        buffered = Buffer.from(value);
      }
      const chunk = buffered.subarray(0, length);
      buffered = buffered.subarray(chunk.length);
      length -= chunk.length;
      checksum.update(chunk);
      yield chunk;
    }
  }

  try {
    for (const [index, { connection, token, length }] of plan.entries()) {
      const checksum = createHash('md5');
      const metadata = split
        ? { name: 'Drivepool-' + id + '-part-' + (index + 1), appProperties: { drivepoolSplit: id } }
        : { name, appProperties: properties(user), ...(folder && { description: 'Drivepool folder: ' + folder }) };
      const file = await uploadDriveFile(token, metadata, split ? 'application/octet-stream' : mime,
        length, split ? take(length, checksum) : req, signal);
      if (split) {
        const md5 = checksum.digest('hex');
        parts.push({ connectionId: connection.id, fileId: file.id, size: length, md5 });
        if (file.md5Checksum !== md5 || Number(file.size) !== length) fail(502, 'Drive could not verify an uploaded part.');
      } else {
        return json(res, 201, { id: file.id, account: connection.email });
      }
    }

    const manifest = { name, size, folder, mimeType: mime, createdTime: new Date().toISOString(), parts };
    savingManifest = true;
    await query('INSERT INTO @split_files (id,user_id,manifest) VALUES (?,?,?)', id, user, JSON.stringify(manifest));
    return json(res, 201, { id, split: true, parts: parts.length });
  } catch (error) {
    // A lost database response can leave a committed manifest. Keep its parts in that case.
    if (!savingManifest) await Promise.allSettled(parts.map(part => {
      const { token } = plan.find(item => item.connection.id === part.connectionId);
      return google(driveApi + '/files/' + part.fileId, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
      });
    }));
    throw error;
  } finally {
    res.off('close', cancel);
    for (const { connection, length } of plan) {
      const reserved = pending.get(connection.subject) - length;
      if (reserved) pending.set(connection.subject, reserved);
      else pending.delete(connection.subject);
    }
  }
}

async function uploadDriveFile(token, metadata, mime, size, body, signal) {
  const start = await google('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum', {
    method: 'POST', signal,
    headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': mime
    },
    body: JSON.stringify(metadata)
  });
  if (!start.ok || !start.headers.get('location')) fail(502, 'Google could not start the upload.');
  const destination = new URL(start.headers.get('location'));
  if (destination.origin !== 'https://www.googleapis.com') fail(502, 'Unexpected Drive upload location.');
  const finish = await google(destination, {
    method: 'PUT', signal, duplex: 'half',
    headers: { 'Content-Length': String(size), 'Content-Type': mime },
    body: size ? body : undefined
  });
  if (!finish.ok) fail(502, 'Google could not complete the upload. Refresh and check before retrying.');
  return finish.json();
}

function attachment(name) {
  return "attachment; filename*=UTF-8''" + encodeURIComponent(name)
    .replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
}

async function splitSource(id, user, connections, signal, ownedOnly = false) {
  const [record] = await query('SELECT user_id,manifest FROM @split_files WHERE id=?', id);
  if (!record) fail(404, 'File not found.');
  const { name, size, folder, parts, trashed, viewers = [] } = JSON.parse(record.manifest);
  if (record.user_id !== user) {
    if (ownedOnly) fail(404, 'File not found.');
    const primary = connections.find(account => hash('drivepool-primary:' + account.subject) === user);
    if (!primary || !viewers.includes(primary.email.toLowerCase())) fail(404, 'File not found.');
    connections = await query('SELECT * FROM @drives WHERE user_id=?', record.user_id);
  }
  if (trashed) fail(404, 'File is in the bin.');
  const sources = await Promise.all(parts.map(async part => {
    const connection = connections.find(account => account.id === part.connectionId);
    if (!connection) fail(409, 'A Drive needed for this file is disconnected.');
    const headers = { Authorization: 'Bearer ' + await access(connection) };
    const target = driveApi + '/files/' + encodeURIComponent(part.fileId);
    const info = await google(target + '?fields=size,md5Checksum,appProperties,trashed', { headers });
    if (!info.ok) fail(409, 'A file part is unavailable. Reconnect its Drive and retry.');
    const file = await info.json();
    if (file.trashed || file.appProperties?.drivepoolSplit !== id ||
        Number(file.size) !== part.size || file.md5Checksum !== part.md5) {
      fail(409, 'A file part is missing or has changed.');
    }
    return { ...part, headers, target };
  }));

  async function* joinParts() {
    for (const part of sources) {
      const media = await google(part.target + '?alt=media', { headers: part.headers, signal });
      if (!media.ok || !media.body) fail(502, 'Drive could not download a file part.');
      let received = 0;
      const checksum = createHash('md5');
      for await (const chunk of Readable.fromWeb(media.body)) {
        received += chunk.length;
        if (received > part.size) fail(502, 'A file part exceeded its expected size.');
        checksum.update(chunk);
        if (received === part.size && checksum.digest('hex') !== part.md5) fail(502, 'A file part failed verification.');
        yield chunk;
      }
      if (received !== part.size) fail(502, 'A file part ended early.');
    }
  }

  return { name, size, folder, open: () => Readable.from(joinParts()) };
}

async function downloadSplit(res, id, user, connections) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  const { name, size, open } = await splitSource(id, user, connections, controller.signal);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': attachment(name),
    'Content-Length': size
  });
  await pipeline(open(), res);
}

const activeFileActions = new Set();

async function driveMutation(target, token, method, data) {
  const response = await google(target, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(502, 'Google Drive could not complete this action. Check access and available space, then retry.');
  }
  return response.json();
}

async function requestText(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) fail(413, 'Request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

function archiveComponent(name) {
  const safe = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[ .]+$/g, '');
  return safe && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? safe : '_' + safe;
}

async function downloadArchive(req, res, user, connections) {
  const form = new URLSearchParams(await requestText(req, 300000));
  let selection;
  try {
    selection = JSON.parse(form.get('selection'));
  } catch {
    fail(400, 'Invalid ZIP selection.');
  }
  if (!Array.isArray(selection) || !selection.length || selection.length > 2000 ||
      selection.some(key => typeof key !== 'string' || !/^[\w-]{1,200}\/[\w-]{1,200}$/.test(key))) {
    fail(400, 'Select between 1 and 2,000 files for a ZIP.');
  }

  const controller = new AbortController();
  res.once('close', () => controller.abort());
  const { signal } = controller;
  const tokens = new Map();
  async function sourceFor(key) {
    const [connectionId, id] = key.split('/');
    if (connectionId === 'split') return splitSource(id, user, connections, signal, true);
    const account = connections.find(connection => connection.id === connectionId);
    if (!account) fail(404, 'A selected file is unavailable.');
    if (!tokens.has(account.id)) tokens.set(account.id, await access(account));
    const headers = { Authorization: 'Bearer ' + tokens.get(account.id) };
    const target = driveApi + '/files/' + id;
    const info = await google(target + '?fields=name,size,description,trashed,appProperties', { headers });
    if (!info.ok) fail(404, 'A selected file is unavailable.');
    const file = await info.json();
    if (file.trashed || file.appProperties?.drivepoolOwner !== user) fail(404, 'A selected file is unavailable.');
    const folder = file.description?.startsWith('Drivepool folder: ') ? file.description.slice(18) : '';
    return { ...file, folder, async open() {
      const media = await google(target + '?alt=media', { headers, signal });
      if (!media.ok || !media.body) fail(502, 'Drive could not download a selected file.');
      return Readable.fromWeb(media.body);
    } };
  }

  const sources = [];
  for (const key of new Set(selection)) sources.push(await sourceFor(key));
  const used = new Set();
  const paths = sources.map(file => {
    const folder = (file.folder || '').split('/').filter(Boolean).map(archiveComponent);
    for (let index = 1; index <= folder.length; index++) used.add(folder.slice(0, index).join('/').toLowerCase());
    return { prefix: folder.length ? folder.join('/') + '/' : '', name: archiveComponent(file.name) };
  });
  const zip = new ZipStream({ store: true, forceZip64: true });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment('Drivepool.zip') });
  const transfer = pipeline(zip, res);
  transfer.catch(error => controller.abort(error));
  try {
    for (const [index, file] of sources.entries()) {
      const { prefix, name } = paths[index];
      let path = prefix + name;
      let suffix = 2;
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : '';
      while (used.has(path.toLowerCase())) path = prefix + stem + ' (' + suffix++ + ')' + extension;
      used.add(path.toLowerCase());
      const stream = await file.open();
      signal.throwIfAborted();
      const entry = new Promise((resolve, reject) => {
        stream.once('error', reject);
        zip.entry(stream, { name: path, store: true }, error => error ? reject(error) : resolve());
      });
      try {
        await Promise.race([entry, transfer]);
      } finally {
        stream.destroy();
      }
    }
    zip.finish();
    await transfer;
  } catch (error) {
    zip.destroy(error);
    await transfer.catch(() => {});
    throw error;
  }
}

async function fileAction(req, res, user, connections, connectionId, id) {
  const body = await requestText(req, 8192);
  let fields;
  try {
    fields = JSON.parse(body);
  } catch {
    fail(400, 'Invalid file action.');
  }
  const action = fields?.action;
  const name = typeof fields?.name === 'string' ? fields.name.trim() : '';
  if (!['rename', 'copy', 'trash', 'share', 'restore', 'delete'].includes(action)) fail(400, 'Invalid file action.');
  if (action === 'rename' && (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name))) {
    fail(400, 'Enter a valid file name.');
  }
  const emailAddress = typeof fields.email === 'string' ? fields.email.trim() : '';
  if (action === 'share' && (!emailAddress || emailAddress.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress))) fail(400, 'Enter a valid recipient email.');

  const destination = fields.folder;
  if (destination !== undefined && (!['rename', 'copy'].includes(action) || typeof destination !== 'string' ||
      !destination || destination.length > 1000 || /[\\\x00-\x1f\x7f]/.test(destination) ||
      destination.split('/').some(segment => !segment || segment === '.' || segment === '..'))) {
    fail(400, 'Invalid folder path.');
  }
  const fromBin = action === 'restore' || action === 'delete';
  const lock = user + '/' + connectionId + '/' + id;
  if (activeFileActions.has(lock)) fail(409, 'Another action is already running for this file.');
  activeFileActions.add(lock);
  try {
    if (connectionId === 'split') {
      const [record] = await query('SELECT manifest FROM @split_files WHERE id=? AND user_id=?', id, user);
      if (!record) fail(404, 'File not found.');
      const file = JSON.parse(record.manifest);
      if (Boolean(file.trashed) !== fromBin) fail(409, 'The file changed. Refresh and try again.');
      if (file.purging && action === 'restore') fail(409, 'Permanent deletion already started. Retry Delete permanently.');
      if (action === 'share') {
        const viewers = [...new Set([...(file.viewers || []), emailAddress.toLowerCase()])];
        if (viewers.length > 100) fail(409, 'This file has reached its sharing limit.');
        await query('UPDATE @split_files SET manifest=? WHERE id=? AND user_id=?',
          JSON.stringify({ ...file, viewers }), id, user);
        return json(res, 200, { url: origin + '/api/split-download/' + id });
      }
      if (action === 'rename') {
        await query('UPDATE @split_files SET manifest=? WHERE id=? AND user_id=?',
          JSON.stringify({ ...file, name, ...(destination && { folder: destination }) }), id, user);
        return json(res, 200, { ok: true });
      }

      const sources = await Promise.all(file.parts.map(async part => {
        const connection = connections.find(account => account.id === part.connectionId);
        if (!connection) fail(409, 'Reconnect the Drive that holds a file part.');
        const token = await access(connection);
        const target = driveApi + '/files/' + encodeURIComponent(part.fileId);
        const info = await google(target + '?fields=size,md5Checksum,appProperties,trashed', {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (info.status === 404 && action === 'delete') return null;
        if (!info.ok) fail(409, 'A file part is unavailable.');
        const metadata = await info.json();
        if ((action !== 'restore' && action !== 'trash' && Boolean(metadata.trashed) !== fromBin) ||
            metadata.appProperties?.drivepoolSplit !== id ||
            Number(metadata.size) !== part.size || metadata.md5Checksum !== part.md5) {
          fail(409, 'A file part is missing or has changed.');
        }
        return { part, token, target, trashed: Boolean(metadata.trashed) };
      }));
      if (fromBin) {
        if (action === 'delete') {
          if (!file.purging) await query('UPDATE @split_files SET manifest=? WHERE id=? AND user_id=?',
            JSON.stringify({ ...file, purging: true }), id, user);
          for (const source of sources.filter(Boolean)) await deleteDriveFile(source.target, source.token, true);
          await query('DELETE FROM @split_files WHERE id=? AND user_id=?', id, user);
        } else {
          for (const source of sources) {
            if (source.trashed) await driveMutation(source.target, source.token, 'PATCH', { trashed: false });
          }
          await query('UPDATE @split_files SET manifest=? WHERE id=? AND user_id=?',
            JSON.stringify({ ...file, trashed: false }), id, user);
        }
        return json(res, 200, { ok: true });
      }

      const changes = [];
      const copyId = randomUUID();
      let saving = false;
      try {
        for (const [index, source] of sources.entries()) {
          const { part, token, target } = source;
          if (action === 'trash') {
            if (source.trashed) continue;
            await driveMutation(target, token, 'PATCH', { trashed: true });
            changes.push({ token, target });
          } else {
            const copy = await driveMutation(target + '/copy?fields=id,size,md5Checksum', token, 'POST', {
              name: 'Drivepool-' + copyId + '-part-' + (index + 1),
              appProperties: { drivepoolSplit: copyId }
            });
            changes.push({ token, target: driveApi + '/files/' + encodeURIComponent(copy.id),
              part: { ...part, fileId: copy.id } });
            if (Number(copy.size) !== part.size || copy.md5Checksum !== part.md5) fail(502, 'A copied part failed verification.');
          }
        }
        saving = true;
        if (action === 'trash') {
          await query('UPDATE @split_files SET manifest=? WHERE id=? AND user_id=?',
            JSON.stringify({ ...file, trashed: true }), id, user);
        } else {
          await query('INSERT INTO @split_files (id,user_id,manifest) VALUES (?,?,?)', copyId, user, JSON.stringify({
            ...file, viewers: [], name: destination ? file.name : copyName(file.name), ...(destination && { folder: destination }), createdTime: new Date().toISOString(), parts: changes.map(change => change.part)
          }));
        }
      } catch (error) {
        // A database connection can fail after a write commits. Avoid undoing Drive changes in that case.
        if (!saving) await Promise.allSettled(changes.map(({ token, target }) =>
          driveMutation(target, token, 'PATCH', { trashed: action !== 'trash' })
        ));
        throw error;
      }
      return json(res, 200, { ok: true });
    }

    const connection = connections.find(account => account.id === connectionId);
    if (!connection) fail(404, 'File not found.');
    const token = await access(connection);
    const target = driveApi + '/files/' + encodeURIComponent(id);
    const info = await google(target + '?fields=name,description,appProperties,trashed', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!info.ok) fail(404, 'File not found.');
    const file = await info.json();
    if (file.appProperties?.drivepoolOwner !== user) fail(404, 'File not found.');
    if (Boolean(file.trashed) !== fromBin) fail(409, 'The file changed. Refresh and try again.');
    if (action === 'restore') await driveMutation(target, token, 'PATCH', { trashed: false });
    if (action === 'delete') await deleteDriveFile(target, token);
    if (action === 'rename') await driveMutation(target, token, 'PATCH', {
      name, ...(destination && { description: 'Drivepool folder: ' + destination })
    });
    if (action === 'trash') await driveMutation(target, token, 'PATCH', { trashed: true });
    if (action === 'copy') {
      await driveMutation(target + '/copy', token, 'POST', {
        name: destination ? file.name : copyName(file.name),
        description: destination ? 'Drivepool folder: ' + destination : file.description,
        appProperties: properties(user)
      });
    }
    if (action === 'share') {
      await driveMutation(target + '/permissions?sendNotificationEmail=true', token, 'POST', {
        type: 'user', role: 'reader', emailAddress
      });
    }
    return json(res, 200, { ok: true });
  } finally {
    activeFileActions.delete(lock);
  }
}

async function deleteDriveFile(target, token, allowMissing = false) {
  const response = await google(target, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok && !(allowMissing && response.status === 404)) {
    await response.body?.cancel();
    fail(502, 'Google Drive could not permanently delete this file. Refresh and retry.');
  }
}

function copyName(name) {
  return 'Copy of ' + name.slice(0, 247);
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
      const records = await query('SELECT id,manifest FROM @split_files WHERE user_id=?', user);
      const splitFiles = records.map(({ id, manifest }) => {
        const { parts, viewers, ...file } = JSON.parse(manifest);
        return { ...file, id, split: true, partCount: parts.length, driveEmails: parts.map(part =>
          connections.find(connection => connection.id === part.connectionId)?.email).filter(Boolean) };
      });
      return json(res, 200, { accounts, splitFiles });
    }
    if (path === '/api/download-zip' && req.method === 'POST') {
      return await downloadArchive(req, res, user, connections);
    }
    if (path === '/api/upload' && req.method === 'POST') return await upload(req, res, url, user, connections);
    const actionMatch = path.match(/^\/api\/file-action\/([\w-]+)\/([\w-]+)$/);
    if (actionMatch && req.method === 'POST') {
      return await fileAction(req, res, user, connections, actionMatch[1], actionMatch[2]);
    }
    const splitDownload = path.match(/^\/api\/split-download\/([\w-]+)$/);
    if (splitDownload && req.method === 'GET') return await downloadSplit(res, splitDownload[1], user, connections);
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
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachment(file.name)
      });
      return await pipeline(Readable.fromWeb(media.body), res);
    }
    fail(404, 'Page not found.');
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 502, { error: error.status ? error.message : 'Request could not complete. Please try again.' });
  }
}).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Drivepool ready on port ${port}. Google OAuth ${configured ? 'enabled' : 'needs setup'}.`));
