'use strict';

/**
 * Test helpers: start the real server as a child process (STORAGE=mock,
 * NODE_ENV=test), talk to it over real HTTP, and inspect its SQLite DB and mock
 * storage directory directly.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vshare-test-'));
  const dataDir = path.join(dir, 'data');
  const storageDir = path.join(dir, 'storage');
  const env = {
    PATH: process.env.PATH,
    STORAGE: 'mock',
    NODE_ENV: 'test',
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    MOCK_STORAGE_DIR: storageDir,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env,
    cwd: dir, // no .env file here, so nothing leaks in from the developer machine
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 15000);
    proc.stdout.on('data', (d) => {
      out += d;
      if (process.env.TEST_LOG_LEVEL) process.stderr.write(d);
      const m = out.match(/listening on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${stderr}`));
    });
  });

  const db = new Database(path.join(dataDir, 'vshare.db'));
  db.pragma('busy_timeout = 5000');

  return {
    port,
    dir,
    dataDir,
    storageDir,
    db,
    proc,
    get stderr() { return stderr; },
    row: (id) => db.prepare('SELECT * FROM files WHERE id = ?').get(id),
    countRows: () => db.prepare('SELECT COUNT(*) AS n FROM files').get().n,
    storageObjects: () => (fs.existsSync(storageDir) ? fs.readdirSync(storageDir) : []),
    objectPath: (storageId) => path.join(storageDir, `${storageId}.bin`),
    async stop() {
      db.close();
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.on('exit', r));
        proc.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Plain HTTP request. Resolves with { status, headers, body (Buffer) }. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Build a multipart/form-data body. Parts are sent in the given order, which
 * lets tests send settings after the file on purpose.
 */
function multipart(parts) {
  const boundary = `----vsharetest${crypto.randomBytes(8).toString('hex')}`;
  const buffers = [];
  for (const part of parts) {
    if (part.filename !== undefined) {
      buffers.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.contentType || 'application/octet-stream'}\r\n\r\n`,
      ));
      buffers.push(part.data);
      buffers.push(Buffer.from('\r\n'));
    } else {
      buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(buffers), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload with settings first (the correct order). Returns { status, json }. */
async function upload(port, { data, filename = 'file.bin', contentType, expiry, expirySeconds, maxDownloads, password, order } = {}) {
  const settings = [];
  if (expiry !== undefined) settings.push({ name: 'expiry', value: expiry });
  if (expirySeconds !== undefined) settings.push({ name: 'expiry_seconds', value: String(expirySeconds) });
  if (maxDownloads !== undefined) settings.push({ name: 'max_downloads', value: String(maxDownloads) });
  if (password !== undefined) settings.push({ name: 'password', value: password });
  const filePart = { name: 'file', filename, contentType, data };
  const parts = order === 'file-first' ? [filePart, ...settings] : [...settings, filePart];
  const { body, contentType: ct } = multipart(parts);
  const res = await request(port, {
    method: 'POST',
    path: '/api/upload',
    headers: { 'Content-Type': ct, 'Content-Length': body.length, Accept: 'application/json' },
    body,
  });
  let json = null;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

/** Browser-style form POST to the download route. */
function download(port, id, { password, headers = {} } = {}) {
  const body = password === undefined ? '' : `password=${encodeURIComponent(password)}`;
  return request(port, {
    method: 'POST',
    path: `/f/${id}/download`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...headers,
    },
    body,
  });
}

/**
 * Start a download and report what actually arrived, tolerating the server
 * hanging up mid-body. Optionally abort after the first chunk.
 */
function rawDownload(port, id, { abortAfterFirstChunk = false } = {}) {
  return new Promise((resolve) => {
    let received = 0;
    let status = 0;
    let expected = -1;
    let done = false;
    const finish = (aborted) => {
      if (done) return;
      done = true;
      resolve({ status, expected, received, aborted });
    };
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/f/${id}/download`, agent: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 },
    }, (res) => {
      status = res.statusCode;
      expected = Number(res.headers['content-length']);
      res.on('data', (c) => {
        received += c.length;
        if (abortAfterFirstChunk) {
          req.destroy();
          finish(true);
        }
      });
      res.on('end', () => finish(false));
      res.on('aborted', () => finish(true));
      res.on('error', () => finish(true));
      res.on('close', () => finish(!res.complete));
    });
    req.on('error', () => finish(true));
    req.end();
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(interval);
  }
}

module.exports = { startServer, request, multipart, upload, download, rawDownload, sha256, sleep, waitFor };
