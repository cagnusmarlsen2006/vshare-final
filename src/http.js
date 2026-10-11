'use strict';

/** HTTP helpers shared by the routes. */
const path = require('path');
const views = require('./views');

// Public ids are nanoid(21).
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{21}$/;

/** True for fetch/XHR callers that explicitly asked for JSON. */
function wantsJson(req) {
  if (req.path.startsWith('/api/')) return true;
  return req.accepts(['html', 'json']) === 'json';
}

/**
 * Send an error in the right format: JSON { error } for API/XHR callers,
 * a friendly HTML page for browsers. Never includes stack traces.
 */
function sendError(req, res, status, message, { title } = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status);
  if (wantsJson(req)) {
    res.json({ error: message });
  } else if (status === 410) {
    res.type('html').send(views.gonePage());
  } else {
    res.type('html').send(views.errorPage({ status, title, message }));
  }
}

/**
 * Sanitise a user-supplied file name for use as metadata.
 * Strips any path, control characters and characters that are unsafe in
 * headers or on common file systems. Never used to build a filesystem path.
 */
function sanitizeFilename(name) {
  let n = String(name || '');
  n = n.split(/[\\/]/).pop(); // drop any directory part
  n = n.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  n = n.replace(/[<>:"|?*]/g, '_');
  n = n.replace(/^[.\s]+/, '').trim(); // no hidden/relative names like ".." or ".env"
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || 'file';
}

/** RFC 6266 / RFC 5987 Content-Disposition with an ASCII fallback. */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { PUBLIC_ID_RE, wantsJson, sendError, sanitizeFilename, contentDisposition };
