'use strict';

/**
 * Streaming benchmark (local, STORAGE=mock, Linux only for the memory reading).
 *   node scripts/bench-stream.js [sizeInMB=100]
 *
 * Uploads a generated file of the given size WITHOUT buffering it on the client,
 * downloads it again, checks SHA-256, and prints the server's peak resident
 * memory (VmHWM from /proc). Used to verify that memory does not grow with file
 * size, i.e. the server really streams.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { startServer } = require('../test/helpers');

const MB = 1024 * 1024;
const sizeMb = Number(process.argv[2] || 100);

function memory(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(s.match(new RegExp(`${k}:\\s+(\\d+)`))[1]);
    return `rss ${(kb('VmRSS') / 1024).toFixed(1)} MB, peak ${(kb('VmHWM') / 1024).toFixed(1)} MB`;
  } catch {
    return 'n/a (needs Linux /proc)';
  }
}

function streamUpload(port, size) {
  const boundary = `b${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="expiry"\r\n\r\n1h\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bench.bin"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = crypto.randomBytes(MB);
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/upload',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + size + tail.length,
        Accept: 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode === 201
        ? resolve({ id: JSON.parse(body).id, sha: hash.digest('hex') })
        : reject(new Error(`upload failed: ${res.statusCode} ${body}`))));
    });
    req.on('error', reject);
    req.write(head);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const part = sent + MB <= size ? chunk : chunk.subarray(0, size - sent);
        sent += part.length;
        hash.update(part);
        if (!req.write(part)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end(tail);
    };
    pump();
  });
}

function streamDownload(port, id) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/f/${id}/download`, headers: { 'Content-Length': 0 } }, (res) => {
      res.on('data', (d) => { bytes += d.length; hash.update(d); });
      res.on('end', () => resolve({ bytes, sha: hash.digest('hex') }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const size = Math.round(sizeMb * MB);
  const srv = await startServer({ NODE_ENV: 'development', MAX_FILE_SIZE_BYTES: String(size + MB) });
  try {
    console.log(`server idle:        ${memory(srv.proc.pid)}`);
    let t = Date.now();
    const up = await streamUpload(srv.port, size);
    console.log(`upload ${sizeMb} MB:    ${((Date.now() - t) / 1000).toFixed(2)} s   server ${memory(srv.proc.pid)}`);
    t = Date.now();
    const down = await streamDownload(srv.port, up.id);
    console.log(`download ${sizeMb} MB:  ${((Date.now() - t) / 1000).toFixed(2)} s   server ${memory(srv.proc.pid)}`);
    console.log(`bytes ${down.bytes}, SHA-256 match: ${down.sha === up.sha}`);
  } finally {
    await srv.stop();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
