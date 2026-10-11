'use strict';

/** Express application factory (API + static frontend on one port). */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const log = require('./logger');
const { sendError } = require('./http');
const { createUploadHandler } = require('./routes/upload');
const { createFileRouter } = require('./routes/files');

function createLimiter(limit, windowMs) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => sendError(req, res, 429, 'Too many requests. Please wait a few minutes and try again.', { title: 'Slow down' }),
  });
}

function createApp({ config, db, repo, files, storage, masterKey }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY === false ? false : (/^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY));

  // Request log with sensitive query values (delete tokens) redacted.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log.info(`${req.method} ${log.redactUrl(req.originalUrl)} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'object-src': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  }));

  const W = config.RATE_LIMITS.windowMs;
  const limiters = {
    global: createLimiter(config.RATE_LIMITS.global, W),
    upload: createLimiter(config.RATE_LIMITS.upload, W),
    download: createLimiter(config.RATE_LIMITS.download, W),
    remove: createLimiter(config.RATE_LIMITS.remove, W),
  };

  // Health check: no secrets, no rate limit (Docker / load balancer probes).
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.set('Cache-Control', 'no-store').type('text').send('ok');
    } catch {
      res.status(503).type('text').send('unhealthy');
    }
  });

  app.use(limiters.global);

  app.get('/api/config', (req, res) => {
    res.json({
      maxFileSizeBytes: config.MAX_FILE_SIZE_BYTES,
      expiryOptions: Object.keys(config.EXPIRY_OPTIONS),
      defaultExpiry: config.DEFAULT_EXPIRY,
      maxDownloadsMax: config.MAX_DOWNLOADS_MAX,
    });
  });

  app.post('/api/upload', limiters.upload, createUploadHandler({ config, repo, files, storage, masterKey }));

  if (config.TEST_HOOKS) {
    // Only reachable when STORAGE=mock AND NODE_ENV=test.
    app.post('/__test__/cleanup', async (req, res) => {
      res.json({ purged: await files.cleanup() });
    });
  }

  app.use(createFileRouter({ config, repo, files, storage, masterKey, limiters }));

  app.use(express.static(path.join(config.ROOT, 'public'), {
    index: 'index.html',
    dotfiles: 'ignore',
    maxAge: config.IS_PROD ? '1h' : 0,
  }));

  app.use((req, res) => sendError(req, res, 404, 'There is nothing here.', { title: 'Page not found' }));

  // Final error handler: correct status, friendly message, never a stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = Number(err.status || err.statusCode) || 500;
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) log.error(`unhandled error on ${req.method} ${req.path}: ${err.message}`);
    const message = status === 413 ? 'Request is too large.'
      : status < 500 ? 'The request could not be processed.'
        : 'Something went wrong on our side. Please try again.';
    sendError(req, res, status, message);
  });

  return app;
}

module.exports = { createApp };
