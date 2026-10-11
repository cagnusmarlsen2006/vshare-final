'use strict';

/**
 * Live demo of the atomic download counter.
 *   node scripts/race-demo.js <share-url> [parallel=6] [password]
 * Fires N simultaneous download POSTs at a share link and prints each result.
 * With a 1-download file exactly one gets 200, the rest get 410.
 */
const http = require('http');
const https = require('https');

const [shareUrl, n = '6', password = ''] = process.argv.slice(2);
if (!shareUrl) {
  console.error('Usage: node scripts/race-demo.js <share-url> [parallel=6] [password]');
  process.exit(1);
}
const url = new URL(shareUrl.replace(/\/$/, '') + '/download');
const client = url.protocol === 'https:' ? https : http;
const body = password ? `password=${encodeURIComponent(password)}` : '';

function fire(i) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ i, status: res.statusCode, bytes, ms: Date.now() - started }));
    });
    req.on('error', (err) => resolve({ i, status: `error: ${err.message}`, bytes: 0, ms: Date.now() - started }));
    req.end(body);
  });
}

(async () => {
  console.log(`Firing ${n} simultaneous downloads at ${url.pathname} …\n`);
  const results = await Promise.all(Array.from({ length: Number(n) }, (_, i) => fire(i + 1)));
  for (const r of results) {
    const label = r.status === 200 ? '✅ 200 OK, got the file' : r.status === 410 ? '💨 410 self-destructed' : `⚠️  ${r.status}`;
    console.log(`request #${r.i}: ${label} (${r.bytes} bytes, ${r.ms} ms)`);
  }
  const ok = results.filter((r) => r.status === 200).length;
  console.log(`\n${ok} of ${n} succeeded.`);
})();
