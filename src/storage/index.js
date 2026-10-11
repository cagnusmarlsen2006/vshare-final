'use strict';

/**
 * Storage factory. Every adapter implements:
 *   upload(readable, { id }) -> Promise<void>
 *   download(id)             -> Promise<Readable>
 *   delete(id)               -> Promise<void>
 */
const { createMockStorage } = require('./mock');

class StorageConfigError extends Error {}

function createStorage(config) {
  if (config.STORAGE === 'mock') {
    return createMockStorage({ dir: config.MOCK_STORAGE_DIR });
  }
  if (config.STORAGE === 'cloudinary') {
    const c = config.CLOUDINARY;
    const missing = [
      ['CLOUDINARY_CLOUD_NAME', c.cloud_name],
      ['CLOUDINARY_API_KEY', c.api_key],
      ['CLOUDINARY_API_SECRET', c.api_secret],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw new StorageConfigError(
        `Cloudinary credentials missing: ${missing.join(', ')}.\n` +
        '  -> Copy .env.example to .env and fill them in, or\n' +
        '  -> run offline with local mock storage: STORAGE=mock (see README).',
      );
    }
    return require('./cloudinary').createCloudinaryStorage(c);
  }
  throw new StorageConfigError(`Unknown STORAGE "${config.STORAGE}". Use "cloudinary" or "mock".`);
}

module.exports = { createStorage, StorageConfigError };
