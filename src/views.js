'use strict';

/**
 * Server-rendered HTML pages. All dynamic values go through esc(). No inline
 * scripts or styles anywhere (strict CSP): behaviour lives in /js/*.js and data
 * is passed via data-* attributes.
 */

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function layout({ title, body, scripts = [], bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Vshare</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/style.css">
<script src="/js/theme.js"></script>
</head>
<body class="${esc(bodyClass)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="/" aria-label="Vshare home"><span class="brand-mark" aria-hidden="true"></span>Vshare</a>
  <nav class="site-nav" aria-label="Systems">
    <a href="/share.html">Share</a><a href="/context.html">Campus</a><a href="/study.html">Study</a><a href="/verify.html">Verify</a>
  </nav>
</header>
<main id="main" class="container" tabindex="-1">
${body}
</main>
<footer class="site-footer"><p>Files are encrypted with AES-256-GCM and destroy themselves.</p></footer>
${[...scripts, '/js/auth-ui.js', '/js/chat.js'].map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
</body>
</html>`;
}

function alertBox(message, kind = 'error') {
  if (!message) return '';
  return `<div class="alert alert-${esc(kind)}" role="alert">${esc(message)}</div>`;
}

/**
 * Download page. Rendering it NEVER consumes a download.
 * @param {object} p
 */
function downloadPage({ id, name, size, remaining, expiresAt, needsPassword, locked, message, messageKind, badges = [] }) {
  const remainingText = remaining === null
    ? 'No download limit'
    : `${remaining} download${remaining === 1 ? '' : 's'} left`;
  const passwordField = needsPassword ? `
      <div class="field">
        <label for="password">This file is password protected</label>
        <input class="clay-input" type="password" id="password" name="password" required
               maxlength="256" autocomplete="off" ${locked ? 'disabled' : ''}>
      </div>` : '';
  return layout({
    title: `Download ${name}`,
    scripts: ['/js/download.js'],
    body: `
<section class="clay-card download-card" aria-labelledby="file-name">
  <div class="file-icon" aria-hidden="true"></div>
  <h1 id="file-name" class="file-name">${esc(name)}</h1>
  ${badges.length ? `<ul class="meta badges" aria-label="About this file">${badges.map((b) => `<li class="chip chip-info">${esc(b)}</li>`).join('')}</ul>` : ''}
  <ul class="meta" aria-label="File details">
    <li class="chip chip-mint">${esc(formatBytes(size))}</li>
    <li class="chip chip-peach" id="remaining">${esc(remainingText)}</li>
    <li class="chip chip-violet countdown" id="countdown" data-expires-at="${esc(expiresAt)}">
      <span class="sr-only">Self-destructs in </span><span class="countdown-value">…</span>
    </li>
  </ul>
  <div id="form-status" aria-live="polite">${alertBox(message, messageKind)}</div>
  <form method="post" action="/f/${esc(id)}/download" class="download-form" id="download-form">
    ${passwordField}
    <button class="clay-button primary big" type="submit" ${locked ? 'disabled' : ''}>Download</button>
  </form>
  <p class="hint">Opening this page does not use up a download. Only pressing Download does.</p>
</section>`,
  });
}

function gonePage() {
  return layout({
    title: 'This file has self-destructed',
    bodyClass: 'gone',
    body: `
<section class="clay-card gone-card" aria-labelledby="gone-title">
  <div class="poof" aria-hidden="true">
    <span class="puff p1"></span><span class="puff p2"></span><span class="puff p3"></span>
    <span class="puff p4"></span><span class="puff p5"></span>
  </div>
  <h1 id="gone-title">This file has self-destructed</h1>
  <p>The link expired, its downloads were used up, or the owner deleted it. It is gone for good.</p>
  <a class="clay-button primary" href="/share.html">Share a new file</a>
</section>`,
  });
}

function errorPage({ status, title, message }) {
  return layout({
    title: title || 'Something went wrong',
    body: `
<section class="clay-card" aria-labelledby="err-title">
  <h1 id="err-title">${esc(title || 'Something went wrong')}</h1>
  <p>${esc(message || 'Please try again.')}</p>
  <p class="hint">Error ${esc(status)}</p>
  <a class="clay-button" href="/">Back to Vshare</a>
</section>`,
  });
}

function deleteConfirmPage({ id, token, name }) {
  return layout({
    title: 'Delete file',
    body: `
<section class="clay-card" aria-labelledby="del-title">
  <h1 id="del-title">Delete this file now?</h1>
  <p>You are about to permanently destroy <strong>${esc(name)}</strong>. The share link will stop working immediately.</p>
  <form method="post" action="/f/${esc(id)}/delete" class="stack">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="button-row">
      <button class="clay-button danger big" type="submit">Yes, destroy it</button>
      <a class="clay-button" href="/">Cancel</a>
    </div>
  </form>
</section>`,
  });
}

function deletedPage() {
  return layout({
    title: 'File destroyed',
    bodyClass: 'gone',
    body: `
<section class="clay-card gone-card" aria-labelledby="deleted-title">
  <div class="poof" aria-hidden="true">
    <span class="puff p1"></span><span class="puff p2"></span><span class="puff p3"></span>
    <span class="puff p4"></span><span class="puff p5"></span>
  </div>
  <h1 id="deleted-title">File destroyed</h1>
  <p>The file and its encryption key are gone. The share link now shows the self-destructed page.</p>
  <a class="clay-button primary" href="/share.html">Share a new file</a>
</section>`,
  });
}

module.exports = { esc, formatBytes, downloadPage, gonePage, errorPage, deleteConfirmPage, deletedPage };
