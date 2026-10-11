'use strict';

/** Entry point: wires config, DB, storage, crypto, cleanup cron and HTTP server. */
const http = require('http');
const cron = require('node-cron');
const config = require('./config');
const log = require('./logger');
const { openDatabase, createRepo } = require('./db');
const { createStorage, StorageConfigError } = require('./storage');
const { loadMasterKey } = require('./crypto');
const { createFileService } = require('./files');
const { createApp } = require('./app');

function fatal(message) {
  console.error(`\n[vshare] ${message}\n`);
  process.exit(1);
}

async function main() {
  let storage;
  try {
    storage = createStorage(config);
  } catch (err) {
    if (err instanceof StorageConfigError) fatal(err.message);
    throw err;
  }

  let masterKey;
  try {
    const mk = loadMasterKey({ envValue: process.env.MASTER_KEY, keyFile: config.MASTER_KEY_FILE });
    masterKey = mk.key;
    if (mk.source === 'generated') log.warn(`no MASTER_KEY set: generated one and saved it to ${config.MASTER_KEY_FILE} (keep it safe, never commit it)`);
    else log.info(`master key loaded from ${mk.source === 'env' ? 'MASTER_KEY' : 'key file'}`);
  } catch (err) {
    fatal(err.message);
  }

  const db = openDatabase(config.DB_FILE);
  const repo = createRepo(db);
  const files = createFileService({ repo, storage });
  const app = createApp({ config, db, repo, files, storage, masterKey });

  // Startup sweep: expired, used-up and abandoned partial uploads from a previous run.
  try {
    await files.cleanup();
  } catch (err) {
    log.warn(`startup cleanup failed: ${err.message}`);
  }
  const task = cron.schedule(config.CLEANUP_CRON, () => {
    files.cleanup().catch((err) => log.warn(`cleanup failed: ${err.message}`));
  }, { noOverlap: true, name: 'vshare-cleanup' });

  const server = http.createServer(app);
  server.requestTimeout = 30 * 60 * 1000; // allow slow uploads of large files
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 5 * 1000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      fatal(`Port ${config.PORT} is already in use. Stop the other process or start with a different port, e.g. PORT=3001.`);
    }
    if (err.code === 'EACCES') fatal(`No permission to listen on port ${config.PORT}. Use a port above 1024.`);
    fatal(`Server error: ${err.message}`);
  });

  server.listen(config.PORT, config.HOST, () => {
    const { port } = server.address();
    console.log(`Vshare listening on http://localhost:${port} (storage: ${storage.name}, max file size: ${config.MAX_FILE_SIZE_BYTES} bytes)`);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${signal} received, shutting down gracefully`);
    Promise.resolve(task.stop()).catch(() => {});
    const force = setTimeout(() => {
      log.warn('forcing shutdown');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    server.closeIdleConnections?.();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  log.error(`unhandled rejection: ${err && err.message}`);
});

main().catch((err) => fatal(`Failed to start: ${err.message}`));
