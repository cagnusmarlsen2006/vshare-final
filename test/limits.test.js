'use strict';

/**
 * Size-limit and test-hook isolation tests (each starts its own server).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { startServer, request, multipart, upload, waitFor } = require('./helpers');

describe('oversize uploads (TEST_MAX_FILE_SIZE_BYTES = 1 MB)', () => {
  let srv;
  before(async () => { srv = await startServer({ TEST_MAX_FILE_SIZE_BYTES: String(1024 * 1024) }); });
  after(async () => { await srv.stop(); });

  it('reports the limit via /api/config', async () => {
    const res = await request(srv.port, { path: '/api/config' });
    assert.equal(JSON.parse(res.body).maxFileSizeBytes, 1024 * 1024);
  });

  it('accepts a file exactly at the limit', async () => {
    const up = await upload(srv.port, { data: crypto.randomBytes(1024 * 1024), expiry: '1h' });
    assert.equal(up.status, 201);
  });

  it('rejects an oversize upload with Content-Length (413, nothing stored)', async () => {
    const before = srv.countRows();
    const up = await upload(srv.port, { data: crypto.randomBytes(2 * 1024 * 1024), expiry: '1h' });
    assert.equal(up.status, 413);
    assert.match(up.json.error, /too large/i);
    assert.equal(srv.countRows(), before);
  });

  it('rejects an oversize CHUNKED upload mid-stream and deletes the partial object', async () => {
    const before = srv.countRows();
    const objectsBefore = srv.storageObjects().length;
    const { body, contentType } = multipart([
      { name: 'expiry', value: '1h' },
      { name: 'file', filename: 'big.bin', data: crypto.randomBytes(3 * 1024 * 1024) },
    ]);
    // No Content-Length: the server can only find out while streaming.
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/upload', agent: false,
        headers: { 'Content-Type': contentType, 'Transfer-Encoding': 'chunked', Accept: 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024));
      req.end();
    });
    assert.equal(res.status, 413);
    assert.match(JSON.parse(res.body).error, /too large/i);
    await waitFor(() => srv.countRows() === before);
    await waitFor(() => srv.storageObjects().length === objectsBefore);
  });
});

describe('test hooks cannot be enabled outside NODE_ENV=test + STORAGE=mock', () => {
  let srv;
  before(async () => {
    srv = await startServer({ NODE_ENV: 'development', TEST_MAX_FILE_SIZE_BYTES: '1000' });
  });
  after(async () => { await srv.stop(); });

  it('ignores TEST_MAX_FILE_SIZE_BYTES', async () => {
    const res = await request(srv.port, { path: '/api/config' });
    assert.equal(JSON.parse(res.body).maxFileSizeBytes, 100 * 1024 * 1024);
  });

  it('rejects expiry_seconds', async () => {
    const up = await upload(srv.port, { data: Buffer.from('x'), expirySeconds: 1 });
    assert.equal(up.status, 400);
    assert.match(up.json.error, /Unknown field/);
  });

  it('has no cleanup endpoint', async () => {
    const res = await request(srv.port, { method: 'POST', path: '/__test__/cleanup', headers: { Accept: 'application/json' } });
    assert.equal(res.status, 404);
  });
});
