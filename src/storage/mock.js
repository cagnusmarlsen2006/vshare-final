'use strict';

/**
 * Local mock storage (STORAGE=mock). Stores ciphertext objects as files in a
 * directory. Used for offline development and automated tests only.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { assertObjectId } = require('./id');

function createMockStorage({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const objectPath = (id) => path.join(dir, `${assertObjectId(id)}.bin`);

  return {
    name: 'mock',

    async upload(readable, { id }) {
      const final = objectPath(id);
      const partial = `${final}.part`;
      try {
        await pipeline(readable, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
        await fsp.rename(partial, final);
      } catch (err) {
        await fsp.rm(partial, { force: true });
        throw err;
      }
    },

    async download(id) {
      const p = objectPath(id);
      // Open first so a missing object is reported as an error, not a stream event.
      const handle = await fsp.open(p, 'r');
      return handle.createReadStream();
    },

    async delete(id) {
      const p = objectPath(id);
      await fsp.rm(p, { force: true });
      await fsp.rm(`${p}.part`, { force: true });
    },

    /** Test helper: absolute path of an object. */
    pathFor: objectPath,
  };
}

module.exports = { createMockStorage };
