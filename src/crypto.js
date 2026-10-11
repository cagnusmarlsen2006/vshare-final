'use strict';

/**
 * Cryptography helpers.
 *
 * Envelope encryption:
 *   - every file gets its own random 256-bit data key (DEK)
 *   - file bytes are encrypted with AES-256-GCM (streamed) using the DEK
 *   - the DEK is wrapped (encrypted) with the MASTER_KEY using AES-256-GCM
 *   - only the wrapped DEK, the IVs and the auth tags are stored in SQLite
 *
 * The file id is bound into both GCM operations as additional authenticated data
 * (AAD), so a wrapped key or ciphertext cannot be swapped between rows.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit IV is the recommended size for GCM
const TAG_BYTES = 16;

// scrypt parameters (N=2^15, r=8, p=1 => ~32 MiB memory per hash).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/* ------------------------------------------------------------------ */
/* Master key                                                          */
/* ------------------------------------------------------------------ */

function parseKey(str) {
  const s = String(str).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  if (b.length === KEY_BYTES && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) return b;
  return null;
}

/**
 * Load the 32-byte master key.
 * Priority: MASTER_KEY env (64 hex chars or base64) > key file > generate + persist.
 * The key is never logged.
 * @returns {{ key: Buffer, source: 'env'|'file'|'generated' }}
 */
function loadMasterKey({ envValue, keyFile }) {
  if (envValue) {
    const key = parseKey(envValue);
    if (!key) throw new Error('MASTER_KEY must be 32 bytes encoded as 64 hex characters or base64');
    return { key, source: 'env' };
  }
  if (fs.existsSync(keyFile)) {
    const key = parseKey(fs.readFileSync(keyFile, 'utf8'));
    if (!key) throw new Error(`Master key file is corrupt: ${keyFile}`);
    return { key, source: 'file' };
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // 'wx' fails if another process created it in the meantime.
  fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return { key, source: 'generated' };
}

/* ------------------------------------------------------------------ */
/* Data keys                                                           */
/* ------------------------------------------------------------------ */

function generateDataKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/** Wrap a data key with the master key. Returns { wrappedKey: ct||tag, wrapIv }. */
function wrapKey(dataKey, masterKey, aad) {
  const wrapIv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(ALGO, masterKey, wrapIv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(dataKey), c.final()]);
  return { wrappedKey: Buffer.concat([ct, c.getAuthTag()]), wrapIv };
}

function unwrapKey(wrappedKey, wrapIv, masterKey, aad) {
  const ct = wrappedKey.subarray(0, wrappedKey.length - TAG_BYTES);
  const tag = wrappedKey.subarray(wrappedKey.length - TAG_BYTES);
  const d = crypto.createDecipheriv(ALGO, masterKey, wrapIv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/* ------------------------------------------------------------------ */
/* Streaming file encryption                                           */
/* ------------------------------------------------------------------ */

/** Returns { cipher (Transform), iv }. Call cipher.getAuthTag() after 'end'. */
function createEncryptStream(dataKey, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, dataKey, iv);
  cipher.setAAD(Buffer.from(aad));
  return { cipher, iv };
}

/**
 * Streaming GCM decryption that WITHHOLDS the most recent plaintext chunk until
 * the auth tag has been verified in final(). If the ciphertext was tampered with,
 * the client never receives the complete Content-Length, so the browser marks the
 * download as failed instead of saving a silently corrupted file.
 */
function createDecryptStream(dataKey, iv, authTag, aad) {
  const decipher = crypto.createDecipheriv(ALGO, dataKey, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(authTag);
  let held = null;
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        const out = decipher.update(chunk);
        if (held && held.length) this.push(held);
        held = out;
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        const last = decipher.final(); // throws if the auth tag does not match
        if (held && held.length) this.push(held);
        if (last.length) this.push(last);
        held = null;
        cb();
      } catch (err) {
        held = null;
        const e = new Error('Integrity check failed (GCM auth tag mismatch)');
        e.code = 'EINTEGRITY';
        cb(e);
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Passwords and tokens                                                */
/* ------------------------------------------------------------------ */

/** Returns "scrypt$<saltHex>$<hashHex>". */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await scrypt(String(password).normalize('NFKC'), salt, expected.length, SCRYPT);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison of a presented token against a stored SHA-256 hex digest. */
function tokenMatches(presented, storedHashHex) {
  if (typeof presented !== 'string' || !presented || !storedHashHex) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  loadMasterKey,
  generateDataKey,
  wrapKey,
  unwrapKey,
  createEncryptStream,
  createDecryptStream,
  hashPassword,
  verifyPassword,
  sha256Hex,
  tokenMatches,
};
