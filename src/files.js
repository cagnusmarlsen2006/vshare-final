'use strict';

/**
 * File lifecycle service: purge (storage + DB), in-flight bookkeeping and the
 * periodic cleanup sweep. This process is the single writer (single instance),
 * so in-memory in-flight counters are authoritative.
 */
const log = require('./logger');

function createFileService({ repo, storage }) {
  const downloadsInFlight = new Map(); // public id -> count
  const uploadsInFlight = new Set(); // public id

  function beginDownload(id) {
    downloadsInFlight.set(id, (downloadsInFlight.get(id) || 0) + 1);
  }

  /** Returns true when no download for `id` is still running. */
  function endDownload(id) {
    const n = (downloadsInFlight.get(id) || 1) - 1;
    if (n <= 0) downloadsInFlight.delete(id);
    else downloadsInFlight.set(id, n);
    return n <= 0;
  }

  const isBusy = (id) => downloadsInFlight.has(id) || uploadsInFlight.has(id);

  /**
   * Remove a file from storage and the DB. If a download is still streaming,
   * the row is only marked 'deleted' (blocking new downloads) and the purge is
   * finished when the last stream ends, or by the next cleanup sweep.
   */
  async function purge(id) {
    const row = repo.get(id);
    if (!row) return false;
    if (row.status !== 'deleted') repo.markDeleted(id);
    if (isBusy(id)) return true;
    try {
      await storage.delete(row.storage_id);
    } catch (err) {
      // Keep the 'deleted' row so the next sweep retries the storage delete.
      log.warn(`storage delete failed for a file; will retry (${err.message})`);
      return false;
    }
    repo.deleteRow(id);
    return true;
  }

  /** Called when a download finished successfully. Deletes after the final allowed one. */
  async function downloadCompleted(id) {
    const r = repo.complete(id);
    const quiet = endDownload(id);
    if (!r) return;
    const usedUp = r.max_downloads !== null && r.completed_downloads >= r.max_downloads;
    const row = repo.get(id);
    if (quiet && (usedUp || (row && row.status === 'deleted'))) await purge(id);
  }

  /** Called when a download failed or was aborted: give the download back. */
  async function downloadFailed(id) {
    repo.rollback(id);
    const quiet = endDownload(id);
    const row = repo.get(id);
    if (quiet && row && row.status === 'deleted') await purge(id);
  }

  let sweeping = false;
  /**
   * Remove expired, used-up, deleted and abandoned (pending, no live upload) files.
   * Returns the number of files purged.
   */
  async function cleanup(now = Date.now()) {
    if (sweeping) return 0;
    sweeping = true;
    let purged = 0;
    try {
      for (const row of repo.dueForCleanup(now)) {
        if (isBusy(row.id)) continue;
        if (await purge(row.id)) purged += 1;
      }
    } finally {
      sweeping = false;
    }
    if (purged) log.info(`cleanup: purged ${purged} file(s)`);
    return purged;
  }

  return {
    beginDownload,
    downloadCompleted,
    downloadFailed,
    beginUpload: (id) => uploadsInFlight.add(id),
    endUpload: (id) => uploadsInFlight.delete(id),
    purge,
    cleanup,
  };
}

module.exports = { createFileService };
