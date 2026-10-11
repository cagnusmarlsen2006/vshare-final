'use strict';

/**
 * Tiny levelled logger. Never pass secrets, keys, passwords or tokens to it.
 * Request URLs are sanitised by redactUrl() before being logged.
 */
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta && meta instanceof Error) out(line, '-', meta.message);
  else if (meta !== undefined) out(line, meta);
  else out(line);
}

/** Replace the value of any sensitive query parameter with [REDACTED]. */
function redactUrl(url) {
  return String(url).replace(/([?&](?:token|password|key|secret)=)[^&#]*/gi, '$1[REDACTED]');
}

module.exports = {
  debug: (m, x) => emit('debug', m, x),
  info: (m, x) => emit('info', m, x),
  warn: (m, x) => emit('warn', m, x),
  error: (m, x) => emit('error', m, x),
  redactUrl,
};
