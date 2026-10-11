'use strict';

/**
 * Context-based (campus-locked) file sharing.
 *
 * Faculty:  POST /api/context/keys    { campus }            -> one-time access key (valid 1 h until used)
 *           POST /api/context/upload  campus, access_key, [expiry], THEN file
 * Student:  POST /api/context/check   { campus, key }       -> file name/size (does NOT use the key)
 *           POST /context/download    campus, key (form)    -> streams the file; the key is then spent
 *
 * The key only works together with the campus it was generated for, and only
 * once (max_downloads = 1, the same atomic claim as share links). Only the
 * SHA-256 of a key is stored. The file's /f/:id page is disabled for these files.
 */
const express = require('express');
const { customAlphabet } = require('nanoid');
const { createUploadHandler, parseSettings, UploadError } = require('./upload');
const { isAvailable } = require('./files');
const { streamClaimedFile } = require('../download');
const cryptoUtil = require('../crypto');
const { sendError } = require('../http');

// No look-alike characters (0/O, 1/I/L). 16 chars from 31 symbols ≈ 79 bits.
const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const makeKeyBody = customAlphabet(KEY_ALPHABET, 16);
const KEY_BODY_RE = new RegExp(`^[${KEY_ALPHABET}]{16}$`);

function formatKey(body) {
  return `VS-${body.match(/.{4}/g).join('-')}`;
}

/** Canonical key body from user input ("vs-ab12 cd34…" -> "AB12CD34…"), or null. */
function canonicalKey(input) {
  const body = String(input || '').toUpperCase().replace(/^VS-?/, '').replace(/[^A-Z0-9]/g, '');
  return KEY_BODY_RE.test(body) ? body : null;
}

const hashKey = (body) => cryptoUtil.sha256Hex(`vshare-access-key:${body}`);

function parseMeta(row) {
  try {
    return row && row.meta ? JSON.parse(row.meta) : {};
  } catch {
    return {};
  }
}

function createContextRouter(deps) {
  const { config, repo, files, storage, masterKey, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '2kb' });
  const form = express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 4 });
  const validCampus = (c) => typeof c === 'string' && config.CAMPUSES.includes(c);

  /* ---------- Faculty: step 1, generate a key ---------- */
  router.post('/api/context/keys', limiters.access, deps.auth.requireFaculty, json, (req, res) => {
    const campus = req.body && req.body.campus;
    if (!validCampus(campus)) {
      res.status(400).json({ error: 'Choose a valid campus.' });
      return;
    }
    const body = makeKeyBody();
    const now = Date.now();
    const expiresAt = now + config.ACCESS_KEY_TTL_MS;
    repo.reserveKey({ key_hash: hashKey(body), campus, created_at: now, expires_at: expiresAt });
    res.status(201).json({ key: formatKey(body), campus, expiresAt });
  });

  /* ---------- Faculty: step 2, upload bound to the key ---------- */
  const profile = {
    fields: new Set(['campus', 'access_key', 'expiry']),
    parse(fields) {
      if (!validCampus(fields.campus)) throw new UploadError(400, 'Choose a valid campus.');
      const body = canonicalKey(fields.access_key);
      if (!body) throw new UploadError(400, 'Generate an access key first (step 1).');
      const keyHash = hashKey(body);
      const reservation = repo.getReservation(keyHash);
      if (!reservation || reservation.file_id || reservation.expires_at <= Date.now()) {
        throw new UploadError(400, 'This access key is unknown, expired or already used. Generate a new one.');
      }
      if (reservation.campus !== fields.campus) {
        throw new UploadError(400, `This key was generated for ${reservation.campus}. Select that campus or generate a new key.`);
      }
      const base = parseSettings({ expiry: fields.expiry || config.DEFAULT_CONTEXT_EXPIRY, expiry_seconds: fields.expiry_seconds }, config);
      return {
        ...base,
        maxDownloads: 1, // "key expires after use"
        password: null,
        kind: 'context',
        meta: { campus: fields.campus },
        accessKeyHash: keyHash,
      };
    },
    finalize({ id, settings }) {
      // Atomic: a key can be bound to exactly one file, even with concurrent uploads.
      const bound = repo.bindReservation({
        key_hash: settings.accessKeyHash, campus: settings.meta.campus, file_id: id, now: Date.now(),
      });
      if (!bound) return { reject: { status: 409, body: { error: 'This access key was just used for another upload. Generate a new one.' } } };
      return {};
    },
    respond: ({ id, name, size, expiresAt, settings, deleteToken }) => ({
      id, name, size, expiresAt, campus: settings.meta.campus, deletePath: `/f/${id}/delete?token=${deleteToken}`,
    }),
  };
  router.post('/api/context/upload', limiters.upload, deps.auth.requireFaculty, createUploadHandler(deps, profile));

  /* ---------- Student ---------- */
  function lookup(campus, key) {
    const body = canonicalKey(key);
    if (!validCampus(campus)) return { status: 400, error: 'Choose your campus.' };
    if (!body) return { status: 400, error: 'That does not look like an access key (format VS-XXXX-XXXX-XXXX-XXXX).' };
    const row = repo.getByAccessKey(hashKey(body));
    if (!row || row.kind !== 'context' || !isAvailable(row, Date.now())) {
      return { status: 410, error: 'This key is invalid, already used or expired.' };
    }
    if (parseMeta(row).campus !== campus) {
      return { status: 403, error: 'This key is locked to a different campus.' };
    }
    return { row };
  }

  // Lets the page show "file found" before the real (one-time) download. Uses nothing up.
  router.post('/api/context/check', limiters.access, json, (req, res) => {
    const r = lookup(req.body && req.body.campus, req.body && req.body.key);
    if (r.error) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    res.json({ name: r.row.original_name, size: r.row.size, expiresAt: r.row.expires_at });
  });

  // Plain form POST so the browser streams the file natively.
  router.post('/context/download', limiters.access, form, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = lookup(req.body && req.body.campus, req.body && req.body.key);
    if (r.error) {
      sendError(req, res, r.status, r.error, { title: 'Access denied' });
      return;
    }
    if (!repo.claim(r.row.id, Date.now())) {
      sendError(req, res, 410, 'This key is invalid, already used or expired.');
      return;
    }
    await streamClaimedFile(req, res, r.row, { files, storage, masterKey });
  });

  return router;
}

module.exports = { createContextRouter, canonicalKey, formatKey };
