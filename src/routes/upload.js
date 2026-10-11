'use strict';

/**
 * Generic encrypted streaming upload handler (multipart/form-data, JSON response).
 *
 * Streaming pipeline:  busboy file stream -> size meter [-> text capture] -> AES-256-GCM cipher -> storage
 * Plaintext never touches the disk. Settings fields must arrive BEFORE the file
 * part, otherwise the upload is rejected.
 *
 * Each sharing system plugs in a "profile":
 *   fields      Set of allowed settings field names
 *   limit       max file size in bytes (defaults to MAX_FILE_SIZE_BYTES)
 *   parse(f)    validate fields -> { expiryMs, maxDownloads, password, kind, meta, accessKeyHash }
 *               (throws UploadError)
 *   captureText true / fn(fileName) -> keep an in-memory plaintext copy for analysis
 *   captureMax  max bytes of that copy (default: limit); larger files are not captured
 *   finalize(ctx) optional async step after storage, before activation:
 *               returns { meta } or { reject: { status, body } } (the upload is then discarded)
 *   respond(ctx) JSON body of the 201 response
 * POST /api/upload uses the default "share" profile (self-destructing links).
 */
const busboy = require('busboy');
const { Transform, pipeline } = require('stream');
const { nanoid } = require('nanoid');
const log = require('../logger');
const cryptoUtil = require('../crypto');
const { sendError, sanitizeFilename } = require('../http');

const SETTINGS_FIELDS = new Set(['expiry', 'max_downloads', 'password']);
const TEST_FIELDS = new Set(['expiry_seconds']);
const SAFE_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;
const MULTIPART_OVERHEAD = 64 * 1024;

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Validate the settings fields. Returns normalised settings or throws UploadError. */
function parseSettings(fields, config) {
  const settings = { password: null, maxDownloads: null, expiryMs: null };

  if (config.TEST_HOOKS && fields.expiry_seconds !== undefined) {
    const s = Number(fields.expiry_seconds);
    if (!Number.isInteger(s) || s < 1 || s > config.TEST_EXPIRY_SECONDS_MAX) {
      throw new UploadError(400, 'Invalid expiry_seconds.');
    }
    settings.expiryMs = s * 1000;
  } else {
    const expiry = fields.expiry === undefined || fields.expiry === '' ? config.DEFAULT_EXPIRY : fields.expiry;
    if (!Object.prototype.hasOwnProperty.call(config.EXPIRY_OPTIONS, expiry)) {
      throw new UploadError(400, `Invalid expiry. Choose one of: ${Object.keys(config.EXPIRY_OPTIONS).join(', ')}.`);
    }
    settings.expiryMs = config.EXPIRY_OPTIONS[expiry];
  }

  if (fields.max_downloads !== undefined && fields.max_downloads !== '') {
    const n = Number(fields.max_downloads);
    if (!Number.isInteger(n) || n < config.MAX_DOWNLOADS_MIN || n > config.MAX_DOWNLOADS_MAX) {
      throw new UploadError(400, `Max downloads must be a whole number from ${config.MAX_DOWNLOADS_MIN} to ${config.MAX_DOWNLOADS_MAX}.`);
    }
    settings.maxDownloads = n;
  }

  if (fields.password !== undefined && fields.password !== '') {
    if (fields.password.length > config.PASSWORD_MAX_LENGTH) {
      throw new UploadError(400, `Password must be at most ${config.PASSWORD_MAX_LENGTH} characters.`);
    }
    settings.password = fields.password;
  }
  return settings;
}

/** Transform that counts bytes and errors as soon as the limit is exceeded. */
function createSizeMeter(limit) {
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      meter.bytes += chunk.length;
      if (meter.bytes > limit) {
        meter.exceeded = true;
        const err = new UploadError(413, 'too large');
        cb(err);
        return;
      }
      cb(null, chunk);
    },
  });
  meter.bytes = 0;
  meter.exceeded = false;
  return meter;
}

/**
 * Reply with an error only AFTER the rest of the request body has been read
 * (discarded). Replying first and closing the socket while the client is still
 * sending makes it see a connection reset (EPIPE) instead of our message. To
 * bound the cost, at most `maxBytes` / `maxMs` are drained before we reply and
 * hang up anyway.
 */
function replyAfterDrain(req, reply, { maxBytes = 8 * 1024 * 1024, maxMs = 10000 } = {}) {
  let done = false;
  let drained = 0;
  let timer = null;
  const finish = (hangUp) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    reply();
    if (hangUp) req.socket.end();
  };
  if (req.complete || req.readableEnded) {
    finish(false);
    return;
  }
  timer = setTimeout(() => finish(true), maxMs);
  req.on('data', (chunk) => {
    drained += chunk.length;
    if (drained > maxBytes) finish(true);
  });
  req.on('end', () => finish(false));
  req.on('close', () => { done = true; clearTimeout(timer); });
  req.resume();
}

/** Default profile: self-destructing share links (POST /api/upload). */
function shareProfile(config) {
  return {
    fields: SETTINGS_FIELDS,
    parse: (fields) => ({ ...parseSettings(fields, config), kind: 'share' }),
    respond: ({ id, name, size, expiresAt, settings, passwordHash, deleteToken }) => ({
      id,
      name,
      size,
      expiresAt,
      maxDownloads: settings.maxDownloads,
      passwordProtected: Boolean(passwordHash),
      sharePath: `/f/${id}`,
      deletePath: `/f/${id}/delete?token=${deleteToken}`,
    }),
  };
}

/**
 * Pass-through transform that keeps an in-memory copy of the plaintext for
 * analysis, up to `max` bytes. Beyond that the copy is dropped (truncated).
 */
function createCapture(max) {
  let chunks = [];
  let total = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      if (!t.truncated) {
        total += chunk.length;
        if (total > max) {
          t.truncated = true;
          chunks = [];
        } else chunks.push(chunk);
      }
      cb(null, chunk);
    },
  });
  t.truncated = false;
  t.buffer = () => (t.truncated ? null : Buffer.concat(chunks));
  return t;
}

function createUploadHandler({ config, repo, files, storage, masterKey }, profile = shareProfile(config)) {
  const limit = profile.limit || config.MAX_FILE_SIZE_BYTES;
  const tooLargeMessage = `File is too large. The maximum size is ${humanSize(limit)}.`;
  const allowedFields = config.TEST_HOOKS ? new Set([...profile.fields, ...TEST_FIELDS]) : profile.fields;

  return function uploadHandler(req, res) {
    const contentType = req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(contentType)) {
      sendError(req, res, 415, 'Upload must be multipart/form-data.');
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit + MULTIPART_OVERHEAD) {
      replyAfterDrain(req, () => {
        res.set('Connection', 'close');
        sendError(req, res, 413, tooLargeMessage);
      });
      return;
    }

    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: 'utf8', // browsers send UTF-8 file names
        limits: { files: 1, fields: 10, parts: 12, fieldNameSize: 64, fieldSize: 2048 },
      });
    } catch {
      sendError(req, res, 400, 'Malformed multipart request.');
      return;
    }

    const fields = Object.create(null);
    const id = nanoid(21);
    const storageId = nanoid(21);
    const deleteToken = nanoid(32);

    let fileSeen = false;
    let failed = false;
    let rowInserted = false;
    let meter = null;
    let fileStream = null;
    let cipher = null;
    let dataIv = null;
    let settings = null;
    let originalName = 'file';
    let mimeType = 'application/octet-stream';
    let uploadPromise = null;
    let pipelineDone = null;
    let capture = null;
    let passwordHashPromise = Promise.resolve(null);

    /** Abort the upload, clean up partial storage + DB row, reply once. */
    function fail(status, message, err) {
      if (failed) return;
      failed = true;
      if (meter && meter.exceeded) {
        status = 413;
        message = tooLargeMessage;
      }
      if (err && status >= 500) log.warn(`upload failed: ${err.message}`);

      req.unpipe(bb);
      // Destroy every stage WITH an error so the storage upload is guaranteed
      // to reject (a bare destroy() of busboy's stream does not propagate).
      const abortErr = new UploadError(status, 'upload aborted');
      for (const s of [fileStream, meter, capture, cipher]) {
        if (s && !s.destroyed) s.destroy(abortErr);
      }

      // Background cleanup of anything that reached storage.
      (async () => {
        if (uploadPromise) await uploadPromise.catch(() => {});
        if (rowInserted) {
          try {
            await storage.delete(storageId);
            repo.deleteRow(id);
          } catch (e) {
            // Row stays 'pending'; the cleanup sweep will retry.
            log.warn(`could not delete partial upload: ${e.message}`);
          }
        }
        files.endUpload(id);
      })();

      replyAfterDrain(req, () => {
        if (res.headersSent) return;
        res.set('Connection', 'close');
        sendError(req, res, status, message);
      });
    }

    req.on('close', () => {
      if (!req.complete && !failed) fail(400, 'Upload was interrupted.');
    });

    bb.on('field', (name, value, info) => {
      if (failed) return;
      if (fileSeen) {
        fail(400, 'Settings must be sent before the file. Please retry the upload.');
        return;
      }
      if (!allowedFields.has(name)) {
        fail(400, `Unknown field "${String(name).slice(0, 32)}".`);
        return;
      }
      if (info.nameTruncated || info.valueTruncated) {
        fail(400, `Field "${name}" is too long.`);
        return;
      }
      if (fields[name] !== undefined) {
        fail(400, `Field "${name}" was sent twice.`);
        return;
      }
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (failed) {
        stream.resume();
        return;
      }
      fileStream = stream;
      // Errors are handled by pipeline()/fail(); this only prevents an
      // unhandled 'error' event if we abort before the pipeline is attached.
      const ignore = () => {};
      stream.on('error', ignore);
      if (name !== 'file') {
        fail(400, 'The file must be sent in a field named "file".');
        return;
      }
      fileSeen = true;

      try {
        settings = profile.parse(fields);
      } catch (err) {
        fail(err.status || 400, err.message);
        return;
      }
      if (settings.password) passwordHashPromise = cryptoUtil.hashPassword(settings.password);
      originalName = sanitizeFilename(info.filename);
      if (info.mimeType && SAFE_MIME_RE.test(info.mimeType)) mimeType = info.mimeType.toLowerCase();

      // Envelope encryption: fresh data key, wrapped by the master key.
      const dataKey = cryptoUtil.generateDataKey();
      const { wrappedKey, wrapIv } = cryptoUtil.wrapKey(dataKey, masterKey, id);
      ({ cipher, iv: dataIv } = cryptoUtil.createEncryptStream(dataKey, id));
      cipher.on('error', ignore);
      dataKey.fill(0);

      const now = Date.now();
      try {
        repo.insertPending({
          id,
          storage_id: storageId,
          original_name: originalName,
          mime_type: mimeType,
          created_at: now,
          expires_at: now + settings.expiryMs,
          max_downloads: settings.maxDownloads,
          delete_token_hash: cryptoUtil.sha256Hex(deleteToken),
          wrapped_key: wrappedKey,
          wrap_iv: wrapIv,
          data_iv: dataIv,
          kind: settings.kind || 'share',
          meta: settings.meta ? JSON.stringify(settings.meta) : null,
        });
      } catch (err) {
        fail(500, 'Could not start the upload.', err);
        return;
      }
      rowInserted = true;
      files.beginUpload(id);

      meter = createSizeMeter(limit);
      meter.on('error', ignore);
      const stages = [stream, meter];
      const wantsCapture = typeof profile.captureText === 'function'
        ? profile.captureText(originalName) : Boolean(profile.captureText);
      if (wantsCapture) {
        capture = createCapture(profile.captureMax || limit);
        capture.on('error', ignore);
        stages.push(capture);
      }
      stages.push(cipher);
      pipelineDone = new Promise((resolve, reject) => {
        pipeline(...stages, (err) => (err ? reject(err) : resolve()));
      });
      pipelineDone.catch((err) => fail(err.status || 500, err.status ? err.message : 'Upload failed.', err));
      uploadPromise = storage.upload(cipher, { id: storageId });
      uploadPromise.catch((err) => fail(502, 'Storage is unavailable. Please try again.', err));
    });

    bb.on('filesLimit', () => fail(400, 'Only one file per upload.'));
    bb.on('fieldsLimit', () => fail(400, 'Too many fields.'));
    bb.on('partsLimit', () => fail(400, 'Too many parts.'));
    bb.on('error', () => fail(400, 'Malformed multipart request.'));

    bb.on('close', async () => {
      if (failed) return;
      if (!fileSeen) {
        fail(400, 'No file was uploaded.');
        return;
      }
      try {
        await Promise.all([pipelineDone, uploadPromise]);
      } catch {
        return; // fail() already handled it
      }
      if (failed) return;
      const ctx = {
        id, settings, deleteToken, name: originalName, mimeType, size: meter.bytes,
        captured: capture ? capture.buffer() : null,
        captureTruncated: Boolean(capture && capture.truncated),
      };
      try {
        const outcome = profile.finalize ? (await profile.finalize(ctx)) || {} : {};
        ctx.captured = null; // drop the plaintext copy as early as possible
        if (outcome.reject) {
          // The profile refused the file (e.g. failed verification): discard it completely.
          failed = true;
          try {
            await storage.delete(storageId);
            repo.deleteRow(id);
          } catch (e) {
            log.warn(`could not discard rejected upload: ${e.message}`);
          }
          files.endUpload(id);
          res.status(outcome.reject.status).json(outcome.reject.body);
          return;
        }
        const passwordHash = await passwordHashPromise;
        const expiresAt = Date.now() + settings.expiryMs;
        const meta = outcome.meta !== undefined ? outcome.meta : settings.meta;
        const ok = repo.activate({
          id,
          size: meter.bytes,
          auth_tag: cipher.getAuthTag(),
          password_hash: passwordHash,
          expires_at: expiresAt,
          meta: meta ? JSON.stringify(meta) : null,
          access_key_hash: settings.accessKeyHash || null,
        });
        if (!ok) throw new Error('activation failed');
        files.endUpload(id);
        res.status(201).json(profile.respond({ ...ctx, expiresAt, passwordHash, meta, outcome }));
      } catch (err) {
        fail(err.status || 500, err.status ? err.message : 'Upload failed.', err);
      }
    });

    req.pipe(bb);
  };
}

module.exports = { createUploadHandler, parseSettings, UploadError, humanSize };
