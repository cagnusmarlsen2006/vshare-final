'use strict';

/**
 * Stream an already-claimed download: unwrap the file key, fetch ciphertext
 * from storage, decrypt (AES-256-GCM, last chunk held until the tag verifies)
 * and pipe to the response. On any failure (client abort, storage error,
 * tampering) the claim is rolled back so the download is not used up.
 * Callers MUST have performed the atomic claim (repo.claim) first.
 */
const { pipeline } = require('stream');
const log = require('./logger');
const cryptoUtil = require('./crypto');
const { sendError, contentDisposition } = require('./http');

// Never let a stored type turn a download into an active document.
const RISKY_MIME_RE = /(html|xml|javascript|ecmascript|svg|x-sh|x-httpd)/i;

async function streamClaimedFile(req, res, row, { files, storage, masterKey }) {
  const { id } = row;
  files.beginDownload(id);

  let source;
  let decrypt;
  try {
    const dataKey = cryptoUtil.unwrapKey(row.wrapped_key, row.wrap_iv, masterKey, id);
    decrypt = cryptoUtil.createDecryptStream(dataKey, row.data_iv, row.auth_tag, id);
    dataKey.fill(0);
    source = await storage.download(row.storage_id);
  } catch (err) {
    log.warn(`download could not start: ${err.message}`);
    await files.downloadFailed(id);
    sendError(req, res, 502, 'The file could not be retrieved right now. Your download was not used up.', { title: 'Download failed' });
    return;
  }

  const contentType = RISKY_MIME_RE.test(row.mime_type) ? 'application/octet-stream' : row.mime_type;
  res.status(200);
  res.set({
    'Content-Type': contentType,
    'Content-Length': String(row.size), // GCM is a stream mode: no padding
    'Content-Disposition': contentDisposition(row.original_name),
    'Cache-Control': 'no-store',
  });

  pipeline(source, decrypt, res, (err) => {
    if (err) {
      // Client abort, storage error or auth-tag failure: give the download back.
      if (err.code === 'EINTEGRITY') log.error('integrity check failed while serving a file');
      else if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn(`download aborted: ${err.message}`);
      res.destroy();
      files.downloadFailed(id).catch((e) => log.error(`rollback failed: ${e.message}`));
    } else {
      files.downloadCompleted(id).catch((e) => log.error(`post-download cleanup failed: ${e.message}`));
    }
  });
}

module.exports = { streamClaimedFile };
