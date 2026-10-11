'use strict';

/**
 * End-to-end tests for the hub, context-based (campus) sharing, study-material
 * distribution, fake-news-proof sharing and the help chatbot.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer, request, multipart, sha256 } = require('./helpers');
const { makeDocx, makePng } = require('./fixtures');

const FIX = path.join(__dirname, 'fixtures');
const REAL = fs.readFileSync(path.join(FIX, 'real-article.txt'));
const FAKE = fs.readFileSync(path.join(FIX, 'fake-article.txt'));

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

async function postMultipart(p, parts) {
  const { body, contentType } = multipart(parts);
  const res = await request(srv.port, {
    method: 'POST', path: p, body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length, Accept: 'application/json' },
  });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function postJson(p, data) {
  const body = JSON.stringify(data);
  const res = await request(srv.port, {
    method: 'POST', path: p, body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
  });
  return { status: res.status, json: JSON.parse(res.body) };
}

function postForm(p, fields, accept = 'text/html') {
  const body = new URLSearchParams(fields).toString();
  return request(srv.port, {
    method: 'POST', path: p, body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Accept: accept },
  });
}

const file = (data, filename) => ({ name: 'file', filename, data });
const rowsNamed = (name) => srv.db.prepare('SELECT * FROM files WHERE original_name = ?').all(name);

describe('hub and pages', () => {
  for (const p of ['/', '/share.html', '/context.html', '/study.html', '/verify.html']) {
    it(`${p} is served with the strict CSP and the chat widget`, async () => {
      const res = await request(srv.port, { path: p });
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline/);
      assert.match(res.body.toString(), /<script src="\/js\/chat\.js" defer><\/script>/);
      assert.doesNotMatch(res.body.toString(), /<script>|style="/);
    });
  }

  it('the hub links all four systems', async () => {
    const html = (await request(srv.port, { path: '/' })).body.toString();
    for (const h of ['/share.html', '/context.html', '/study.html', '/verify.html']) assert.ok(html.includes(`href="${h}"`), h);
  });

  it('/api/config exposes the lists the pages need', async () => {
    const cfg = JSON.parse((await request(srv.port, { path: '/api/config' })).body);
    assert.ok(cfg.campuses.includes('Main Campus'));
    assert.ok(cfg.departments.includes('CSE'));
    assert.deepEqual(cfg.years, ['1', '2', '3', '4']);
    assert.ok(cfg.materialTypes.includes('Question Bank'));
  });
});

describe('context-based (campus-locked) sharing', () => {
  const data = crypto.randomBytes(300 * 1024);
  let key;

  it('rejects an unknown campus when generating a key', async () => {
    assert.equal((await postJson('/api/context/keys', { campus: 'Moon Campus' })).status, 400);
  });

  it('generates a one-time key for a campus (only its hash is stored)', async () => {
    const r = await postJson('/api/context/keys', { campus: 'North Campus' });
    assert.equal(r.status, 201);
    key = r.json.key;
    assert.match(key, /^VS-[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
    const n = srv.db.prepare('SELECT COUNT(*) AS n FROM access_keys WHERE key_hash LIKE ?').get(`%${key.slice(3, 7)}%`).n;
    assert.equal(n, 0, 'the key itself is not stored');
  });

  it('refuses an upload whose campus does not match the key', async () => {
    const r = await postMultipart('/api/context/upload', [
      { name: 'campus', value: 'Main Campus' }, { name: 'access_key', value: key }, file(data, 'notes.bin'),
    ]);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /generated for North Campus/);
  });

  it('refuses an upload without a generated key', async () => {
    const r = await postMultipart('/api/context/upload', [
      { name: 'campus', value: 'North Campus' }, { name: 'access_key', value: 'VS-2222-3333-4444-5555' }, file(data, 'x.bin'),
    ]);
    assert.equal(r.status, 400);
  });

  it('faculty upload binds the file to the key', async () => {
    const r = await postMultipart('/api/context/upload', [
      { name: 'campus', value: 'North Campus' }, { name: 'access_key', value: key }, { name: 'expiry', value: '1d' },
      file(data, 'lab-manual.bin'),
    ]);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.campus, 'North Campus');
    assert.match(r.json.deletePath, /^\/f\/[\w-]{21}\/delete\?token=/);
    const row = rowsNamed('lab-manual.bin')[0];
    assert.equal(row.kind, 'context');
    assert.equal(row.max_downloads, 1);
    assert.ok(row.access_key_hash);
  });

  it('the same key cannot be used for a second upload', async () => {
    const r = await postMultipart('/api/context/upload', [
      { name: 'campus', value: 'North Campus' }, { name: 'access_key', value: key }, file(data, 'second.bin'),
    ]);
    assert.equal(r.status, 400);
    assert.equal(rowsNamed('second.bin').length, 0);
  });

  it('student check: wrong campus 403, unknown key 410, malformed key 400, right campus 200 (uses nothing up)', async () => {
    assert.equal((await postJson('/api/context/check', { campus: 'Main Campus', key })).status, 403);
    assert.equal((await postJson('/api/context/check', { campus: 'North Campus', key: 'VS-2222-3333-4444-5555' })).status, 410);
    assert.equal((await postJson('/api/context/check', { campus: 'North Campus', key: 'hello' })).status, 400);
    const ok = await postJson('/api/context/check', { campus: 'North Campus', key: key.toLowerCase().replace(/-/g, ' ') });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.name, 'lab-manual.bin');
    assert.equal(rowsNamed('lab-manual.bin')[0].downloads, 0);
  });

  it('the file is NOT reachable through its public /f/:id link', async () => {
    const { id } = rowsNamed('lab-manual.bin')[0];
    assert.equal((await request(srv.port, { path: `/f/${id}` })).status, 410);
    assert.equal((await postForm(`/f/${id}/download`, {})).status, 410);
  });

  it('wrong campus on the download form gives a friendly 403 page', async () => {
    const r = await postForm('/context/download', { campus: 'South Campus', key });
    assert.equal(r.status, 403);
    assert.match(r.body.toString(), /locked to a different campus/);
  });

  it('student downloads with key + campus, byte-for-byte; the key then expires', async () => {
    const r = await postForm('/context/download', { campus: 'North Campus', key });
    assert.equal(r.status, 200);
    assert.equal(sha256(r.body), sha256(data));
    assert.match(r.headers['content-disposition'], /lab-manual\.bin/);
    const again = await postForm('/context/download', { campus: 'North Campus', key });
    assert.equal(again.status, 410);
    assert.equal((await postJson('/api/context/check', { campus: 'North Campus', key })).status, 410);
  });
});

describe('study-material distribution', () => {
  const upload = (fields, f) => postMultipart('/api/study/upload', [
    ...Object.entries(fields).map(([name, value]) => ({ name, value })), f,
  ]);
  const base = { department: 'CSE', year: '2', subject: 'Public Health Informatics', material_type: 'Notes' };

  it('validates department, year, material type and subject', async () => {
    assert.equal((await upload({ ...base, department: 'LAW' }, file(REAL, 'a.txt'))).status, 400);
    assert.equal((await upload({ ...base, year: '7' }, file(REAL, 'a.txt'))).status, 400);
    assert.equal((await upload({ ...base, material_type: 'Memes' }, file(REAL, 'a.txt'))).status, 400);
    assert.equal((await upload({ ...base, subject: '' }, file(REAL, 'a.txt'))).status, 400);
  });

  it('distributes a document and auto-tags it with TF-IDF keywords', async () => {
    const r = await upload(base, file(REAL, 'measles-notes.txt'));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.department, 'CSE');
    assert.equal(r.json.year, '2');
    assert.ok(r.json.keywords.includes('measles'), r.json.keywords.join(','));
  });

  it('binary files are distributed without keywords', async () => {
    const r = await upload({ ...base, material_type: 'Reference' }, file(makePng(16, 16), 'diagram.png'));
    assert.equal(r.status, 201);
    assert.equal(r.json.keywords, undefined);
  });

  it('other classes do not see it; the right class does', async () => {
    await upload({ ...base, department: 'ECE', year: '1', subject: 'Signals' }, file(makeDocx(), 'signals.docx'));
    const list = async (d, y) => JSON.parse((await request(srv.port, { path: `/api/study/materials?department=${encodeURIComponent(d)}&year=${y}` })).body);
    const cse2 = await list('CSE', '2');
    assert.deepEqual(cse2.materials.map((m) => m.name).sort(), ['diagram.png', 'measles-notes.txt']);
    const ece1 = await list('ECE', '1');
    assert.deepEqual(ece1.materials.map((m) => m.name), ['signals.docx']);
    assert.equal((await list('CSE', '3')).materials.length, 0);
    assert.equal((await request(srv.port, { path: '/api/study/materials?department=X&year=1' })).status, 400);
  });

  it('students download through the normal page, with class badges, any number of times', async () => {
    const { id } = rowsNamed('measles-notes.txt')[0];
    const page = (await request(srv.port, { path: `/f/${id}` })).body.toString();
    assert.match(page, /CSE · Year 2/);
    assert.match(page, /No download limit/);
    for (let i = 0; i < 3; i++) {
      const r = await postForm(`/f/${id}/download`, {});
      assert.equal(r.status, 200);
      assert.equal(sha256(r.body), sha256(REAL));
    }
  });
});

describe('fake-news-proof sharing', () => {
  const verify = (data, name, source, trusted = '') => postMultipart('/api/verify/upload', [
    { name: 'source_url', value: source }, { name: 'trusted_domains', value: trusted }, file(data, name),
  ]);

  it('credible content from a reputable source is shared, with a full report', async () => {
    const r = await verify(REAL, 'measles-report.txt', 'https://www.reuters.com/world/europe/measles');
    assert.equal(r.status, 201, JSON.stringify(r.json && r.json.error));
    const rep = r.json.report;
    assert.equal(rep.verdict, 'credible');
    assert.ok(rep.credibility >= 65);
    assert.ok(rep.components.ml.probabilityFake >= 0 && rep.components.ml.probabilityFake <= 1);
    assert.equal(rep.components.source.category, 'reputable');
    assert.ok(rep.entities.length > 3);
    assert.ok(rep.keywords.length > 3);
    const row = rowsNamed('measles-report.txt')[0];
    assert.equal(row.kind, 'verified');
    const page = (await request(srv.port, { path: r.json.sharePath })).body.toString();
    assert.match(page, /✓ Verified · credibility \d+\/100/);
    assert.match(page, /Source: www\.reuters\.com|Source: reuters\.com/);
  });

  it('trusted domains given by the uploader count as a good source', async () => {
    const r = await verify(REAL, 'college-circular.txt', 'https://news.mycollege.edu.in/c/1', 'mycollege.edu.in');
    assert.equal(r.status, 201);
    assert.equal(r.json.report.components.source.category, 'trusted-by-you');
  });

  it('misinformation is rejected with a 422 report and nothing is kept', async () => {
    const before = new Set(srv.storageObjects());
    const r = await verify(FAKE, 'miracle-cure.txt', 'https://truth-news-now.xyz/cure');
    assert.equal(r.status, 422);
    assert.equal(r.json.report.verdict, 'likely-fake');
    assert.equal(r.json.report.shareable, false);
    assert.match(r.json.error, /Not shared/);
    assert.equal(r.json.sharePath, undefined);
    assert.equal(rowsNamed('miracle-cure.txt').length, 0);
    assert.ok(srv.storageObjects().every((o) => before.has(o)), 'rejected ciphertext deleted from storage');
  });

  it('a file without readable text cannot be verified', async () => {
    const r = await verify(makePng(32, 32), 'photo.png', 'https://www.reuters.com/x');
    assert.equal(r.status, 422);
    assert.equal(r.json.report.components.ml, null);
  });

  it('enforces the 10 MB analysis limit', async () => {
    const r = await verify(crypto.randomBytes(10 * 1024 * 1024 + 1), 'big.txt', '');
    assert.equal(r.status, 413);
  });
});

describe('help chatbot API', () => {
  it('answers with an intent, links and suggestions', async () => {
    const r = await postJson('/api/chat', { message: 'How do campus keys work for students?' });
    assert.equal(r.status, 200);
    assert.equal(r.json.intent, 'context_student');
    assert.ok(r.json.reply.length > 20);
    assert.ok(r.json.links.every((l) => l.href.startsWith('/')));
  });

  it('rejects empty messages', async () => {
    assert.equal((await postJson('/api/chat', { message: '   ' })).status, 400);
  });
});

describe('database migration', () => {
  it('upgrades a v1 database in place (adds the new columns, keeps rows)', () => {
    const { openDatabase } = require('../src/db');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vshare-mig-'));
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, storage_id TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, max_downloads INTEGER, downloads INTEGER NOT NULL DEFAULT 0,
      completed_downloads INTEGER NOT NULL DEFAULT 0, password_hash TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER, delete_token_hash TEXT NOT NULL, wrapped_key BLOB NOT NULL, wrap_iv BLOB NOT NULL,
      data_iv BLOB NOT NULL, auth_tag BLOB);
      INSERT INTO files (id, storage_id, original_name, mime_type, status, created_at, expires_at, delete_token_hash,
      wrapped_key, wrap_iv, data_iv) VALUES ('a', 'b', 'old.txt', 'text/plain', 'active', 1, 2, 'h', x'00', x'00', x'00');`);
    old.close();
    const db = openDatabase(file);
    const cols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
    assert.ok(['kind', 'meta', 'access_key_hash'].every((c) => cols.includes(c)));
    assert.equal(db.prepare('SELECT kind FROM files WHERE id = ?').get('a').kind, 'share');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
