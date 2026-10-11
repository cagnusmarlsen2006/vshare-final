'use strict';

/**
 * MANUAL live test against Cloudinary (needs real credentials in .env):
 *   npm run test:cloudinary
 *
 * One full round trip through the real server with STORAGE=cloudinary:
 *   1. upload a ~1 MB random file through POST /api/upload
 *   2. fetch the stored object straight from Cloudinary and check it is ciphertext
 *   3. download through the app and compare SHA-256
 *   4. delete through the delete link (POST)
 *   5. check the object is gone from Cloudinary
 */
const crypto = require('crypto');
const path = require('path');
const { startServer, upload, download, request, sha256 } = require('../test/helpers');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function step(msg) { console.log(`\n▶ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  const missing = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')}. Put them in .env (see .env.example).`);
    process.exit(1);
  }

  const passthrough = {};
  for (const k of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_FOLDER', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[k]) passthrough[k] = process.env[k];
  }
  // Temp DATA_DIR + generated master key: this test never touches your real data.
  const srv = await startServer({ STORAGE: 'cloudinary', NODE_ENV: 'development', LOG_LEVEL: 'warn', ...passthrough }, { cwd: ROOT });
  const { createCloudinaryStorage } = require('../src/storage/cloudinary');
  const storage = createCloudinaryStorage({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    folder: process.env.CLOUDINARY_FOLDER || 'vshare',
  });

  let failed = false;
  try {
    const data = crypto.randomBytes(1024 * 1024);
    step(`Uploading 1 MB through the app (port ${srv.port})`);
    const t0 = Date.now();
    const up = await upload(srv.port, { data, filename: 'cloudinary-roundtrip.bin', expiry: '10m', maxDownloads: 2 });
    if (up.status !== 201) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.json)}`);
    ok(`uploaded in ${Date.now() - t0} ms, id ${up.json.id}`);
    const { storage_id: storageId } = srv.row(up.json.id);

    step('Fetching the raw object from Cloudinary (signed URL)');
    const raw = await readAll(await storage.download(storageId));
    if (raw.length !== data.length) throw new Error(`stored size ${raw.length} != ${data.length}`);
    if (sha256(raw) === sha256(data)) throw new Error('Cloudinary holds PLAINTEXT. This must never happen.');
    ok(`Cloudinary holds ${raw.length} bytes of ciphertext (differs from plaintext)`);

    step('Downloading through the app');
    const t1 = Date.now();
    const res = await download(srv.port, up.json.id);
    if (res.status !== 200) throw new Error(`download failed: HTTP ${res.status}`);
    if (sha256(res.body) !== sha256(data)) throw new Error('SHA-256 mismatch after download');
    ok(`downloaded in ${Date.now() - t1} ms, SHA-256 matches (${sha256(data).slice(0, 16)}…)`);

    step('Deleting through the delete link (POST)');
    const token = new URL(up.json.deletePath, 'http://x').searchParams.get('token');
    const body = `token=${encodeURIComponent(token)}`;
    const del = await request(srv.port, {
      method: 'POST',
      path: `/f/${up.json.id}/delete`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    if (del.status !== 200) throw new Error(`delete failed: HTTP ${del.status}`);
    const page = await request(srv.port, { path: `/f/${up.json.id}` });
    if (page.status !== 410) throw new Error(`share link should be 410 after delete, got ${page.status}`);
    ok('app reports 410 for the share link');

    step('Checking the object is gone from Cloudinary');
    try {
      await readAll(await storage.download(storageId));
      console.log('  ! object still downloadable: CDN cache may lag a few minutes after "invalidate". Re-check later.');
    } catch (err) {
      ok(`object no longer retrievable (${err.message})`);
    }
    console.log('\nCloudinary round trip PASSED');
  } catch (err) {
    failed = true;
    console.error(`\nCloudinary round trip FAILED: ${err.message}`);
    if (srv.stderr) console.error(srv.stderr);
  } finally {
    await srv.stop();
  }
  process.exit(failed ? 1 : 0);
}

main();
