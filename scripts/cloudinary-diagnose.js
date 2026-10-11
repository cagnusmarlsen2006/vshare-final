'use strict';

/**
 * Cloudinary diagnostics (manual, needs .env with real credentials):
 *   npm run cloudinary:diagnose
 *
 * The SDK hides the body of some error responses (e.g. 403 is reported only as
 * "Server returned unexpected status code"). This script performs tiny signed
 * uploads itself and prints Cloudinary's raw answer for each combination, so the
 * real reason for a failure is visible. Every test object it creates is deleted.
 * Secrets are never printed.
 */
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const cloudinary = require('cloudinary').v2;

const cloud = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const key = (process.env.CLOUDINARY_API_KEY || '').trim();
const secret = (process.env.CLOUDINARY_API_SECRET || '').trim();

function mask(v) {
  return v ? `${v.slice(0, 4)}… (${v.length} chars)` : '(missing)';
}

// 1x1 transparent PNG, so the image test cannot fail with "invalid image".
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function signedUpload(resourceType, type) {
  const publicId = `vshare-diagnose-${crypto.randomBytes(4).toString('hex')}`;
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000), type };
  const signature = cloudinary.utils.api_sign_request(params, secret);
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append('api_key', key);
  form.append('signature', signature);
  const file = resourceType === 'image' ? PNG : Buffer.from('vshare diagnostics');
  form.append('file', new Blob([file]), resourceType === 'image' ? 'diag.png' : 'diag.txt');
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  return { status: res.status, text, publicId };
}

async function main() {
  console.log('Values read from .env (secrets masked):');
  console.log(`  CLOUDINARY_CLOUD_NAME = ${cloud || '(missing)'}`);
  console.log(`  CLOUDINARY_API_KEY    = ${key || '(missing)'}`);
  console.log(`  CLOUDINARY_API_SECRET = ${mask(secret)}`);
  if (!cloud || !key || !secret) {
    console.log('\nOne or more values are missing. Check .env (no quotes, no brackets, no spaces).');
    process.exit(1);
  }
  if (/[\s"'<>]/.test(cloud + key + secret)) {
    console.log('\n! A value contains spaces, quotes or < > characters. Remove them from .env.');
  }

  cloudinary.config({ cloud_name: cloud, api_key: key, api_secret: secret, secure: true });

  console.log('\n1) Credentials check (Admin API ping):');
  try {
    const r = await cloudinary.api.ping();
    console.log(`   OK: ${JSON.stringify(r)}`);
  } catch (err) {
    const e = err.error || err;
    console.log(`   FAILED: HTTP ${e.http_code || '?'}: ${e.message || JSON.stringify(e)}`);
  }

  console.log('\n2) Tiny signed uploads (raw Cloudinary responses):');
  const combos = [
    ['raw', 'authenticated'], // what Vshare uses
    ['raw', 'upload'],
    ['image', 'upload'],
  ];
  for (const [resourceType, type] of combos) {
    try {
      const r = await signedUpload(resourceType, type);
      const ok = r.status === 200;
      console.log(`   ${resourceType}/${type}: HTTP ${r.status} ${ok ? 'OK' : 'FAILED'}`);
      if (!ok) console.log(`      response: ${r.text.slice(0, 500)}`);
      if (ok) {
        await cloudinary.uploader.destroy(r.publicId, { resource_type: resourceType, type, invalidate: true })
          .catch(() => {});
      }
    } catch (err) {
      console.log(`   ${resourceType}/${type}: request error: ${err.message}`);
    }
  }
  console.log('\nCopy everything above (it contains no secrets) and send it back.');
}

main();
