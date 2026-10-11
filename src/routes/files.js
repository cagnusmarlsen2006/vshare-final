'use strict';

/**
 * Share-link routes:
 *   GET  /f/:id            download page (never counts a download)
 *   HEAD /f/:id            same status/headers as GET, no body, no side effects
 *   POST /f/:id/download   the ONLY request that counts a download
 *   GET  /f/:id/download   redirect to the page (link previews, refreshes)
 *   HEAD /f/:id/download   405 (never counts)
 *   GET  /f/:id/delete     confirmation page (does not delete)
 *   POST /f/:id/delete     delete now (token in the POST body)
 */
const express = require('express');
const views = require('../views');
const cryptoUtil = require('../crypto');
const { PUBLIC_ID_RE, wantsJson, sendError } = require('../http');
const { streamClaimedFile } = require('../download');

function remainingDownloads(row) {
  return row.max_downloads === null ? null : Math.max(0, row.max_downloads - row.downloads);
}

/** Is this row currently downloadable (ignoring password/lock)? */
function isAvailable(row, now) {
  if (!row || row.status !== 'active') return false;
  if (row.expires_at <= now) return false;
  const remaining = remainingDownloads(row);
  return remaining === null || remaining > 0;
}

/**
 * Downloadable through the public /f/:id link? Campus-locked (context) files are
 * only reachable with their access key + campus, never by id.
 */
function isPublic(row, now) {
  return isAvailable(row, now) && row.kind !== 'context';
}

/** Short labels shown on the download page for study / verified files. */
function badgesFor(row) {
  let meta = {};
  try {
    meta = row.meta ? JSON.parse(row.meta) : {};
  } catch {
    meta = {};
  }
  if (row.kind === 'study') {
    return [`${meta.department} · Year ${meta.year}`, meta.materialType, meta.subject].filter(Boolean);
  }
  if (row.kind === 'verified') {
    const out = [`✓ Verified · credibility ${meta.credibility}/100`];
    if (meta.sourceDomain) out.push(`Source: ${meta.sourceDomain}`);
    return out;
  }
  return [];
}

const isLocked = (row, now) => row.locked_until !== null && row.locked_until > now;

function lockMessage(row, now) {
  const minutes = Math.max(1, Math.ceil((row.locked_until - now) / 60000));
  return `Too many wrong passwords. This file is locked for ${minutes} more minute${minutes === 1 ? '' : 's'}.`;
}

function setPrivateHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function createFileRouter({ config, repo, files, storage, masterKey, limiters }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 5 });

  router.param('id', (req, res, next, id) => {
    if (!PUBLIC_ID_RE.test(id)) {
      sendError(req, res, 404, 'This link is not valid.', { title: 'Link not found' });
      return;
    }
    setPrivateHeaders(res);
    next();
  });

  function renderPage(res, row, now, extra = {}) {
    const locked = isLocked(row, now);
    res.type('html').send(views.downloadPage({
      id: row.id,
      name: row.original_name,
      size: row.size,
      remaining: remainingDownloads(row),
      expiresAt: row.expires_at,
      needsPassword: Boolean(row.password_hash),
      locked,
      message: extra.message || (locked ? lockMessage(row, now) : ''),
      messageKind: extra.messageKind || 'error',
      badges: badgesFor(row),
    }));
  }

  /* ---------------- download page ---------------- */

  // Explicit HEAD handler: reports the status only. No body, no side effects.
  router.head('/f/:id', (req, res) => {
    const row = repo.get(req.params.id);
    res.status(isPublic(row, Date.now()) ? 200 : 410).type('html').end();
  });

  router.get('/f/:id', (req, res) => {
    const now = Date.now();
    const row = repo.get(req.params.id);
    if (!isPublic(row, now)) {
      sendError(req, res, 410, 'This file has self-destructed.');
      return;
    }
    renderPage(res, row, now);
  });

  /* ---------------- download (POST only) ---------------- */

  router.head('/f/:id/download', (req, res) => {
    res.set('Allow', 'POST').status(405).end();
  });

  router.get('/f/:id/download', (req, res) => {
    res.redirect(303, `/f/${req.params.id}`);
  });

  router.post('/f/:id/download', limiters.download, form, async (req, res) => {
    const id = req.params.id;
    let now = Date.now();
    let row = repo.get(id);
    if (!isPublic(row, now)) {
      sendError(req, res, 410, 'This file has self-destructed.');
      return;
    }

    const reject = (status, message) => {
      if (wantsJson(req)) {
        res.status(status).json({ error: message });
      } else {
        res.status(status);
        renderPage(res, repo.get(id) || row, Date.now(), { message });
      }
    };

    if (isLocked(row, now)) {
      reject(423, lockMessage(row, now));
      return;
    }

    if (row.password_hash) {
      const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!password) {
        reject(401, 'Please enter the password.');
        return;
      }
      const ok = password.length <= config.PASSWORD_MAX_LENGTH
        && await cryptoUtil.verifyPassword(password, row.password_hash);
      now = Date.now();
      if (!ok) {
        const r = repo.registerFailure(id, config.MAX_FAILED_ATTEMPTS, now + config.LOCKOUT_MS);
        if (r && r.locked_until !== null && r.locked_until > now) {
          reject(423, `Too many wrong passwords. This file is locked for ${Math.round(config.LOCKOUT_MS / 60000)} minutes.`);
        } else {
          const left = r ? config.MAX_FAILED_ATTEMPTS - r.failed_attempts : 0;
          reject(403, `Wrong password. ${left} attempt${left === 1 ? '' : 's'} left before a 15-minute lock.`);
        }
        return;
      }
      repo.resetFailures(id);
    }

    // Atomic claim: a single UPDATE that only succeeds while downloads remain,
    // the file is active, unexpired and not locked.
    if (!repo.claim(id, Date.now())) {
      row = repo.get(id);
      if (row && row.status === 'active' && isLocked(row, Date.now())) reject(423, lockMessage(row, Date.now()));
      else sendError(req, res, 410, 'This file has self-destructed.');
      return;
    }
    await streamClaimedFile(req, res, row, { files, storage, masterKey });
  });

  /* ---------------- delete ---------------- */

  function findForDelete(req, res, token) {
    const row = repo.get(req.params.id);
    if (!row || row.status !== 'active') {
      sendError(req, res, 410, 'This file has self-destructed.');
      return null;
    }
    if (!cryptoUtil.tokenMatches(token, row.delete_token_hash)) {
      sendError(req, res, 403, 'This delete link is not valid.', { title: 'Invalid delete link' });
      return null;
    }
    return row;
  }

  // GET only shows a confirmation page. Nothing is deleted here (link scanners
  // and previews follow GET links).
  router.get('/f/:id/delete', limiters.remove, (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const row = findForDelete(req, res, token);
    if (!row) return;
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html').send(views.deleteConfirmPage({ id: row.id, token, name: row.original_name }));
  });

  router.post('/f/:id/delete', limiters.remove, form, async (req, res) => {
    const token = req.body && typeof req.body.token === 'string' ? req.body.token
      : (typeof req.query.token === 'string' ? req.query.token : '');
    const row = findForDelete(req, res, token);
    if (!row) return;
    await files.purge(row.id);
    if (wantsJson(req)) res.json({ deleted: true });
    else res.type('html').send(views.deletedPage());
  });

  return router;
}

module.exports = { createFileRouter, isAvailable };
