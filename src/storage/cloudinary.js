'use strict';

/**
 * Cloudinary storage adapter.
 *   - resource_type "raw" (arbitrary bytes), type "authenticated" (not publicly
 *     reachable without a signature)
 *   - uploads via upload_stream (no temp files)
 *   - downloads via a short-lived signed URL, streamed back through the server
 * Cloudinary only ever receives ciphertext: encryption happens before upload.
 */
const https = require('https');
const { pipeline } = require('stream');
const { assertObjectId } = require('./id');

const RESOURCE = { resource_type: 'raw', type: 'authenticated' };
const MAX_REDIRECTS = 3;

function httpsGetStream(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpsGetStream(new URL(headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        const err = new Error(`Cloudinary download failed with HTTP ${statusCode}`);
        err.statusCode = statusCode;
        reject(err);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Cloudinary download timed out')));
  });
}

function createCloudinaryStorage(creds) {
  // Lazy require so STORAGE=mock never loads the SDK.
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: creds.cloud_name,
    api_key: creds.api_key,
    api_secret: creds.api_secret,
    secure: true,
  });
  const folder = creds.folder ? `${creds.folder.replace(/[^A-Za-z0-9_/-]/g, '')}/` : '';
  const publicId = (id) => `${folder}${assertObjectId(id)}`;

  return {
    name: 'cloudinary',

    upload(readable, { id }) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err, result) => {
          if (settled) return;
          settled = true;
          if (err) {
            const e = err instanceof Error ? err : new Error(err.message || 'Cloudinary upload failed');
            // The SDK hides the response body for 403; point operators at the diagnostics.
            if (/\b403\b/.test(e.message)) {
              e.message += ' (Cloudinary refused the upload: check the API key permissions and the'
                + ' security settings for raw/authenticated uploads; run "npm run cloudinary:diagnose")';
            }
            reject(e);
          } else {
            resolve(result);
          }
        };
        const up = cloudinary.uploader.upload_stream(
          { ...RESOURCE, public_id: publicId(id), overwrite: false, unique_filename: false, timeout: 120000 },
          (err, result) => done(err, result),
        );
        // If the source fails (size limit, client abort), the upload stream is
        // destroyed so Cloudinary never finalises a partial object.
        pipeline(readable, up, (err) => {
          if (err) done(err);
        });
      });
    },

    async download(id) {
      const pid = publicId(id);
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      // Primary: signed delivery URL for the authenticated raw asset.
      const signed = cloudinary.url(pid, { ...RESOURCE, sign_url: true, secure: true });
      try {
        return await httpsGetStream(signed);
      } catch (err) {
        if (![401, 403, 404].includes(err.statusCode)) throw err;
      }
      // Fallback: time-limited private download API URL.
      const apiUrl = cloudinary.utils.private_download_url(pid, '', { ...RESOURCE, expires_at: expiresAt });
      return httpsGetStream(apiUrl);
    },

    async delete(id) {
      const res = await cloudinary.uploader.destroy(publicId(id), { ...RESOURCE, invalidate: true });
      if (res && res.result !== 'ok' && res.result !== 'not found') {
        throw new Error(`Cloudinary delete failed: ${res.result}`);
      }
    },
  };
}

module.exports = { createCloudinaryStorage };
