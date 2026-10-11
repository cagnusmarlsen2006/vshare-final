'use strict';

/**
 * End-to-end tests against the real server (STORAGE=mock, NODE_ENV=test).
 * Run with:  npm test
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { fixtures } = require('./fixtures');
const {
  startServer, request, multipart, upload, download, rawDownload, sha256, sleep, waitFor,
} = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (process.env.TEST_LOG_LEVEL) console.log(srv.stderr); await srv.stop(); });

const MB = 1024 * 1024;

describe('basics', () => {
  it('GET /healthz returns ok and nothing sensitive', async () => {
    const res = await request(srv.port, { path: '/healthz' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'ok');
  });

  it('serves the upload page with a strict CSP (no inline scripts/styles)', async () => {
    const res = await request(srv.port, { path: '/' });
    assert.equal(res.status, 200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
  });
});

describe('upload and download round trips (byte-for-byte SHA-256)', () => {
  for (const f of fixtures()) {
    it(`${f.filename} (${f.data.length} bytes)`, async () => {
      const up = await upload(srv.port, { ...f, expiry: '1h' });
      assert.equal(up.status, 201, JSON.stringify(up.json));
      assert.equal(up.json.size, f.data.length);
      assert.equal(up.json.name, f.filename);

      // Storage only holds ciphertext of exactly the same length (GCM: no padding).
      const row = srv.row(up.json.id);
      const stored = fs.readFileSync(srv.objectPath(row.storage_id));
      assert.equal(stored.length, f.data.length);
      assert.notEqual(sha256(stored), sha256(f.data));

      const res = await download(srv.port, up.json.id);
      assert.equal(res.status, 200);
      assert.equal(Number(res.headers['content-length']), f.data.length);
      assert.match(res.headers['content-disposition'], /^attachment; filename="/);
      assert.ok(res.headers['content-disposition'].includes(`filename*=UTF-8''${encodeURIComponent(f.filename)}`));
      assert.equal(sha256(res.body), sha256(f.data));
    });
  }

  it('20 MB file streams through intact', async () => {
    const data = crypto.randomBytes(20 * MB);
    const up = await upload(srv.port, { data, filename: 'big.bin', expiry: '1h' });
    assert.equal(up.status, 201, JSON.stringify(up.json));
    const res = await download(srv.port, up.json.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, data.length);
    assert.equal(sha256(res.body), sha256(data));
  });
});

describe('download limits', () => {
  it('max 1 download: only the first download works, then 410 and the file is purged', async () => {
    const data = Buffer.from('one time only');
    const up = await upload(srv.port, { data, filename: 'once.txt', expiry: '1h', maxDownloads: 1 });
    const { storage_id: storageId } = srv.row(up.json.id);

    const first = await download(srv.port, up.json.id);
    assert.equal(first.status, 200);
    assert.equal(first.body.toString(), 'one time only');

    const second = await download(srv.port, up.json.id);
    assert.equal(second.status, 410);
    assert.match(second.body.toString(), /This file has self-destructed/);

    // Deleted right after the final allowed download.
    await waitFor(() => !srv.row(up.json.id));
    assert.equal(fs.existsSync(srv.objectPath(storageId)), false);
    const page = await request(srv.port, { path: `/f/${up.json.id}` });
    assert.equal(page.status, 410);
  });

  it('max N downloads: exactly N succeed', async () => {
    const up = await upload(srv.port, { data: Buffer.from('three'), expiry: '1h', maxDownloads: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await download(srv.port, up.json.id);
      assert.equal(r.status, 200, `download ${i + 1}`);
    }
    assert.equal((await download(srv.port, up.json.id)).status, 410);
  });

  it('6 simultaneous downloads of a 1-download file: exactly one succeeds', async () => {
    const data = crypto.randomBytes(2 * MB);
    const up = await upload(srv.port, { data, expiry: '1h', maxDownloads: 1 });
    const results = await Promise.all(Array.from({ length: 6 }, () => download(srv.port, up.json.id)));
    const ok = results.filter((r) => r.status === 200);
    const gone = results.filter((r) => r.status === 410);
    assert.equal(ok.length, 1, `statuses: ${results.map((r) => r.status)}`);
    assert.equal(gone.length, 5);
    assert.equal(sha256(ok[0].body), sha256(data));
  });

  it('opening the page, GET on the download URL and HEAD requests never count', async () => {
    const up = await upload(srv.port, { data: Buffer.from('peek'), expiry: '1h', maxDownloads: 1 });
    const id = up.json.id;
    for (let i = 0; i < 3; i++) assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 200);
    const head = await request(srv.port, { method: 'HEAD', path: `/f/${id}` });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    const headDl = await request(srv.port, { method: 'HEAD', path: `/f/${id}/download` });
    assert.equal(headDl.status, 405);
    const getDl = await request(srv.port, { path: `/f/${id}/download` });
    assert.equal(getDl.status, 303);
    // Link-preview bot user agents get the page, nothing more.
    const bot = await request(srv.port, { path: `/f/${id}`, headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } });
    assert.equal(bot.status, 200);

    assert.equal(srv.row(id).downloads, 0);
    assert.equal((await download(srv.port, id)).status, 200);
  });

  it('an interrupted download is rolled back and does not count', async () => {
    const data = crypto.randomBytes(20 * MB);
    const up = await upload(srv.port, { data, expiry: '1h', maxDownloads: 1 });
    const id = up.json.id;
    const r = await rawDownload(srv.port, id, { abortAfterFirstChunk: true });
    assert.equal(r.status, 200);
    assert.ok(r.aborted);
    assert.ok(r.received < data.length);
    await waitFor(() => srv.row(id).downloads === 0);
    assert.equal(srv.row(id).completed_downloads, 0);
    // The single allowed download is still available.
    const full = await download(srv.port, id);
    assert.equal(full.status, 200);
    assert.equal(sha256(full.body), sha256(data));
  });
});

describe('expiry and cleanup', () => {
  it('a file expires after its time limit (410) and cleanup removes it from storage and DB', async () => {
    const up = await upload(srv.port, { data: Buffer.from('short lived'), expirySeconds: 1 });
    assert.equal(up.status, 201);
    const id = up.json.id;
    const { storage_id: storageId } = srv.row(id);
    assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 200);

    await sleep(1300);
    assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 410);
    assert.equal((await download(srv.port, id)).status, 410);
    assert.ok(fs.existsSync(srv.objectPath(storageId)), 'still on storage until cleanup');

    const c = await request(srv.port, { method: 'POST', path: '/__test__/cleanup' });
    assert.equal(c.status, 200);
    assert.equal(srv.row(id), undefined);
    assert.equal(fs.existsSync(srv.objectPath(storageId)), false);
  });

  it('cleanup removes abandoned partial uploads (pending rows + partial objects)', async () => {
    const id = 'abandonedAbandoned123';
    const storageId = 'partialPartialPartial';
    srv.db.prepare(`
      INSERT INTO files (id, storage_id, original_name, mime_type, status, created_at, expires_at,
        delete_token_hash, wrapped_key, wrap_iv, data_iv)
      VALUES (?, ?, 'x.bin', 'application/octet-stream', 'pending', ?, ?, 'x', x'00', x'00', x'00')`)
      .run(id, storageId, Date.now() - 3600e3, Date.now() + 3600e3);
    fs.writeFileSync(srv.objectPath(storageId), 'partial ciphertext');
    fs.writeFileSync(`${srv.objectPath(storageId)}.part`, 'partial ciphertext');

    await request(srv.port, { method: 'POST', path: '/__test__/cleanup' });
    assert.equal(srv.row(id), undefined);
    assert.equal(fs.existsSync(srv.objectPath(storageId)), false);
    assert.equal(fs.existsSync(`${srv.objectPath(storageId)}.part`), false);
  });
});

describe('passwords', () => {
  it('correct password downloads; missing or wrong password re-renders the page with a message', async () => {
    const data = Buffer.from('secret stuff');
    const up = await upload(srv.port, { data, expiry: '1h', password: 'correct horse' });
    assert.equal(up.json.passwordProtected, true);
    const id = up.json.id;

    const page = await request(srv.port, { path: `/f/${id}` });
    assert.match(page.body.toString(), /type="password"/);

    const none = await download(srv.port, id);
    assert.equal(none.status, 401);
    assert.match(none.headers['content-type'], /text\/html/);

    const wrong = await download(srv.port, id, { password: 'nope' });
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.toString(), /Wrong password\. 4 attempts left/);
    assert.match(wrong.body.toString(), /<form method="post"/); // the download page, re-rendered

    const json = await download(srv.port, id, { password: 'nope', headers: { Accept: 'application/json' } });
    assert.equal(json.status, 403);
    assert.match(JSON.parse(json.body).error, /Wrong password/);

    const ok = await download(srv.port, id, { password: 'correct horse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), 'secret stuff');
    assert.equal(srv.row(id).failed_attempts, 0, 'a correct password resets the counter');

    // Password hash is scrypt, never the password itself.
    assert.match(srv.row(id).password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  it('5 wrong attempts lock the file for 15 minutes; it is never deleted', async () => {
    const up = await upload(srv.port, { data: Buffer.from('locked'), expiry: '1h', password: 'right', maxDownloads: 1 });
    const id = up.json.id;
    for (let i = 1; i <= 4; i++) {
      assert.equal((await download(srv.port, id, { password: `wrong${i}` })).status, 403);
    }
    const fifth = await download(srv.port, id, { password: 'wrong5' });
    assert.equal(fifth.status, 423);
    assert.match(fifth.body.toString(), /locked for 15 minutes/);

    const row = srv.row(id);
    assert.ok(row.locked_until > Date.now() + 14 * 60e3 && row.locked_until <= Date.now() + 15 * 60e3);

    // Even the right password is refused while locked, and nothing is consumed.
    assert.equal((await download(srv.port, id, { password: 'right' })).status, 423);
    const pg = await request(srv.port, { path: `/f/${id}` });
    assert.equal(pg.status, 200);
    assert.match(pg.body.toString(), /Too many wrong passwords/);
    assert.equal(srv.row(id).downloads, 0);
    assert.equal(srv.row(id).status, 'active');

    // Simulate 15 minutes passing: the file works again.
    srv.db.prepare('UPDATE files SET locked_until = ? WHERE id = ?').run(Date.now() - 1, id);
    const ok = await download(srv.port, id, { password: 'right' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), 'locked');
  });
});

describe('delete link', () => {
  it('GET only shows a confirmation; wrong tokens are rejected; POST deletes', async () => {
    const up = await upload(srv.port, { data: Buffer.from('delete me'), expiry: '1h' });
    const id = up.json.id;
    const { storage_id: storageId, delete_token_hash: hash } = srv.row(id);
    const token = new URL(up.json.deletePath, 'http://x').searchParams.get('token');
    assert.equal(token.length, 32);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, token, 'only the SHA-256 hash is stored');

    const confirm = await request(srv.port, { path: up.json.deletePath });
    assert.equal(confirm.status, 200);
    assert.match(confirm.body.toString(), /Delete this file now\?/);
    assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 200, 'GET did not delete');

    const badGet = await request(srv.port, { path: `/f/${id}/delete?token=${'x'.repeat(32)}` });
    assert.equal(badGet.status, 403);

    const post = (tok) => {
      const body = `token=${encodeURIComponent(tok)}`;
      return request(srv.port, {
        method: 'POST',
        path: `/f/${id}/delete`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
    };
    assert.equal((await post('wrong-token-wrong-token-wrong-to')).status, 403);
    assert.equal((await post('')).status, 403);
    assert.ok(srv.row(id), 'wrong token deleted nothing');

    const ok = await post(token);
    assert.equal(ok.status, 200);
    assert.match(ok.body.toString(), /File destroyed/);
    assert.equal(srv.row(id), undefined);
    assert.equal(fs.existsSync(srv.objectPath(storageId)), false);
    assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 410);
  });
});

describe('integrity', () => {
  it('tampered ciphertext fails the GCM check, the client never gets the full file, and the count is rolled back', async () => {
    const data = crypto.randomBytes(512 * 1024);
    const up = await upload(srv.port, { data, expiry: '1h', maxDownloads: 1 });
    const id = up.json.id;
    const p = srv.objectPath(srv.row(id).storage_id);
    const buf = fs.readFileSync(p);
    buf[1000] ^= 0xff; // flip one byte
    fs.writeFileSync(p, buf);

    const r = await rawDownload(srv.port, id);
    assert.equal(r.status, 200);
    assert.equal(r.expected, data.length);
    assert.ok(r.aborted, 'connection must be cut');
    assert.ok(r.received < data.length, `received ${r.received} of ${data.length}`);
    await waitFor(() => srv.row(id).downloads === 0);
    assert.equal(srv.row(id).status, 'active');
  });
});

describe('upload validation', () => {
  it('rejects settings sent after the file and leaves nothing behind', async () => {
    const objectsBefore = new Set(srv.storageObjects());
    const filename = `late-settings-${Date.now()}.bin`;
    const up = await upload(srv.port, {
      data: crypto.randomBytes(300 * 1024), filename, expiry: '1h', maxDownloads: 2, order: 'file-first',
    });
    assert.equal(up.status, 400);
    assert.match(up.json.error, /before the file/);
    const rowsNamed = () => srv.db.prepare('SELECT COUNT(*) AS n FROM files WHERE original_name = ?').get(filename).n;
    await waitFor(() => rowsNamed() === 0);
    await waitFor(() => srv.storageObjects().every((o) => objectsBefore.has(o)));
  });

  it('rejects invalid settings with JSON errors', async () => {
    const data = Buffer.from('x');
    assert.equal((await upload(srv.port, { data, expiry: '99y' })).status, 400);
    assert.equal((await upload(srv.port, { data, expiry: '1h', maxDownloads: 0 })).status, 400);
    assert.equal((await upload(srv.port, { data, expiry: '1h', maxDownloads: 11 })).status, 400);
    assert.equal((await upload(srv.port, { data, expiry: '1h', password: 'p'.repeat(257) })).status, 400);
    const noFile = multipart([{ name: 'expiry', value: '1h' }]);
    const r = await request(srv.port, {
      method: 'POST', path: '/api/upload',
      headers: { 'Content-Type': noFile.contentType, 'Content-Length': noFile.body.length },
      body: noFile.body,
    });
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(JSON.parse(r.body)), ['error']);
  });

  it('sanitises path-traversal file names (metadata only)', async () => {
    const up = await upload(srv.port, { data: Buffer.from('t'), filename: '../../etc/passwd', expiry: '1h' });
    assert.equal(up.status, 201);
    assert.equal(up.json.name, 'passwd');
    const row = srv.row(up.json.id);
    assert.match(row.storage_id, /^[A-Za-z0-9_-]{21}$/);
  });

  it('unknown ids give 410, malformed ids 404, and errors never leak stack traces', async () => {
    const gone = await request(srv.port, { path: '/f/AAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(gone.status, 410);
    const bad = await request(srv.port, { path: '/f/..%2F..%2Fetc' });
    assert.equal(bad.status, 404);
    const json = await request(srv.port, { path: '/f/AAAAAAAAAAAAAAAAAAAAA', headers: { Accept: 'application/json' } });
    assert.deepEqual(JSON.parse(json.body), { error: 'This file has self-destructed.' });
    const malformed = await request(srv.port, {
      method: 'POST', path: '/api/upload',
      headers: { 'Content-Type': 'multipart/form-data; boundary=zzz', 'Content-Length': 9 },
      body: 'garbage!!',
    });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(malformed.body.toString(), /at .*\.js:\d+/);
  });
});
