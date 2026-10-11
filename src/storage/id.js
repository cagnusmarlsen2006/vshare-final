'use strict';

// Storage object ids are nanoid(21): URL-safe alphabet only. Validating the
// shape here makes path traversal impossible in every adapter.
const OBJECT_ID_RE = /^[A-Za-z0-9_-]{21}$/;

function assertObjectId(id) {
  if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) {
    throw new Error('Invalid storage object id');
  }
  return id;
}

module.exports = { OBJECT_ID_RE, assertObjectId };
