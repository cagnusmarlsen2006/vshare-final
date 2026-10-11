'use strict';

/**
 * Central configuration. Every tunable lives here so there is exactly ONE place
 * to change limits (in particular MAX_FILE_SIZE_BYTES).
 */
const path = require('path');

require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..');
const MB = 1024 * 1024;

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const STORAGE = (env.STORAGE || 'cloudinary').toLowerCase();

/**
 * Test-only hooks (short expiry_seconds, tiny size limit, manual cleanup endpoint)
 * are enabled ONLY when both STORAGE=mock and NODE_ENV=test. There is no other
 * switch, so a production deployment (Cloudinary storage) can never enable them.
 */
const TEST_HOOKS = STORAGE === 'mock' && NODE_ENV === 'test';

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * Max upload size.
 * - Cloudinary free plans cap "raw" uploads at 10 MB, so that is the default there.
 * - Mock (local) storage defaults to 100 MB.
 * - MAX_FILE_SIZE_BYTES in the environment overrides both.
 * - TEST_MAX_FILE_SIZE_BYTES is honoured only when TEST_HOOKS is on.
 */
function resolveMaxFileSize() {
  if (TEST_HOOKS && env.TEST_MAX_FILE_SIZE_BYTES) {
    return intFromEnv('TEST_MAX_FILE_SIZE_BYTES', 1 * MB, { min: 1, max: 100 * MB });
  }
  const def = STORAGE === 'mock' ? 100 * MB : 10 * MB;
  return intFromEnv('MAX_FILE_SIZE_BYTES', def, { min: 1, max: 5 * 1024 * MB });
}

/** Comma-separated list from the environment, e.g. CAMPUSES="Main Campus,North Campus". */
function listFromEnv(name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 60));
  return list.length ? [...new Set(list)] : fallback;
}

const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');

const config = Object.freeze({
  ROOT,
  NODE_ENV,
  IS_TEST: NODE_ENV === 'test',
  IS_PROD: NODE_ENV === 'production',
  TEST_HOOKS,

  PORT: intFromEnv('PORT', 3000, { min: 0, max: 65535 }),
  HOST: env.HOST || '0.0.0.0',
  // e.g. "1" when running behind exactly one reverse proxy (Caddy / nginx).
  TRUST_PROXY: env.TRUST_PROXY || false,
  LOG_LEVEL: env.LOG_LEVEL || (NODE_ENV === 'test' ? 'warn' : 'info'),

  STORAGE,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'vshare.db'),
  MASTER_KEY_FILE: path.join(DATA_DIR, '.master.key'),
  MOCK_STORAGE_DIR: path.resolve(ROOT, env.MOCK_STORAGE_DIR || '.mock_storage'),

  CLOUDINARY: {
    cloud_name: env.CLOUDINARY_CLOUD_NAME || '',
    api_key: env.CLOUDINARY_API_KEY || '',
    api_secret: env.CLOUDINARY_API_SECRET || '',
    folder: env.CLOUDINARY_FOLDER || 'vshare',
  },

  MAX_FILE_SIZE_BYTES: resolveMaxFileSize(),

  // Destruction rules offered to users.
  EXPIRY_OPTIONS: Object.freeze({
    '10m': 10 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  }),
  DEFAULT_EXPIRY: '1d',
  MAX_DOWNLOADS_MIN: 1,
  MAX_DOWNLOADS_MAX: 10,
  // Test hook: expiry_seconds range.
  TEST_EXPIRY_SECONDS_MAX: 3600,

  // Context-based sharing (campus-locked one-time keys).
  CAMPUSES: Object.freeze(listFromEnv('CAMPUSES', ['Main Campus', 'North Campus', 'South Campus', 'City Campus'])),
  ACCESS_KEY_TTL_MS: 60 * 60 * 1000, // an unused generated key expires after 1 hour
  DEFAULT_CONTEXT_EXPIRY: '7d',

  // Study-material distribution.
  DEPARTMENTS: Object.freeze(listFromEnv('DEPARTMENTS', ['CSE', 'IT', 'ECE', 'EEE', 'MECH', 'CIVIL', 'AI & DS'])),
  YEARS: Object.freeze(['1', '2', '3', '4']),
  MATERIAL_TYPES: Object.freeze(['Notes', 'Question Bank', 'Assignment', 'Syllabus', 'Reference']),
  STUDY_EXPIRY_OPTIONS: Object.freeze({
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '180d': 180 * 24 * 60 * 60 * 1000,
  }),
  DEFAULT_STUDY_EXPIRY: '90d',

  // Fake-news-proof sharing: the file is analysed in memory, so it is capped.
  VERIFY_MAX_BYTES: Math.min(10 * MB, resolveMaxFileSize()),

  // Passwords.
  PASSWORD_MAX_LENGTH: 256,
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,

  // Cleanup.
  CLEANUP_CRON: '* * * * *',

  // Rate limits (per IP, per window). Relaxed under NODE_ENV=test.
  RATE_LIMITS: NODE_ENV === 'test'
    ? { windowMs: 60 * 1000, global: 100000, upload: 100000, download: 100000, remove: 100000, access: 100000, chat: 100000 }
    : { windowMs: 15 * 60 * 1000, global: 1000, upload: 30, download: 60, remove: 30, access: 30, chat: 120 },

  SHUTDOWN_TIMEOUT_MS: 10000,
});

module.exports = config;
