/* Shared helpers for the Vshare pages (no dependencies). Exposes window.Vshare. */
(function () {
  'use strict';

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  /** Replace the content of a status box with one alert. kind: error | success | info */
  function showStatus(box, message, kind) {
    box.textContent = '';
    if (!message) return;
    var div = document.createElement('div');
    div.className = 'alert alert-' + (kind || 'error');
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.textContent = message;
    box.appendChild(div);
  }

  var configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch('/api/config', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return configPromise;
  }

  /** Fill a <select> with options. items: strings or [value, label] pairs. */
  function fillSelect(select, items, selected) {
    select.textContent = '';
    items.forEach(function (it) {
      var value = Array.isArray(it) ? it[0] : it;
      var label = Array.isArray(it) ? it[1] : it;
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      if (value === selected) o.selected = true;
      select.appendChild(o);
    });
  }

  /**
   * POST multipart form data with real upload progress.
   * Resolves { status, body } (body = parsed JSON or null). Rejects on network error.
   */
  function xhrUpload(url, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', function (ev) {
        if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100, false);
      });
      xhr.upload.addEventListener('load', function () { if (onProgress) onProgress(100, true); });
      xhr.addEventListener('load', function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
        resolve({ status: xhr.status, body: body });
      });
      xhr.addEventListener('error', function () { reject(new Error('network')); });
      xhr.addEventListener('timeout', function () { reject(new Error('timeout')); });
      xhr.send(formData);
    });
  }

  function postJson(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    });
  }

  /** Progress capsule controller for markup: .progress > .progress-track[role=progressbar] > .progress-fill */
  function progress(root) {
    var track = root.querySelector('[role="progressbar"]');
    var fill = root.querySelector('.progress-fill');
    var label = root.querySelector('.progress-label');
    return {
      show: function () { root.hidden = false; },
      hide: function () { root.hidden = true; },
      set: function (pct, text) {
        var p = Math.max(0, Math.min(100, Math.round(pct)));
        fill.style.width = p + '%';
        track.setAttribute('aria-valuenow', String(p));
        if (label) label.textContent = (text || 'Uploading…') + ' ' + p + '%';
      },
    };
  }

  /** Copy buttons: <button data-copy-target="inputId">Copy</button> */
  function initCopyButtons(scope, liveRegion) {
    Array.prototype.forEach.call((scope || document).querySelectorAll('[data-copy-target]'), function (btn) {
      if (btn.dataset.copyReady) return;
      btn.dataset.copyReady = '1';
      btn.addEventListener('click', function () {
        var target = document.getElementById(btn.getAttribute('data-copy-target'));
        var done = function () {
          btn.textContent = 'Copied!';
          btn.classList.remove('copied');
          void btn.offsetWidth;
          btn.classList.add('copied');
          if (liveRegion) liveRegion.textContent = 'Copied to clipboard';
          setTimeout(function () {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
            if (liveRegion) liveRegion.textContent = '';
          }, 1800);
        };
        var fallback = function () {
          target.focus();
          target.select();
          try { if (document.execCommand('copy')) { done(); return; } } catch (e) { /* ignore */ }
          if (liveRegion) liveRegion.textContent = 'Press Ctrl+C (or Cmd+C) to copy';
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(target.value).then(done, fallback);
        else fallback();
      });
    });
  }

  /** Drag-and-drop tray (label.dropzone wrapping an <input type=file>). Calls onFile(file). */
  function initDropzone(zone, input, onFile) {
    var depth = 0;
    input.addEventListener('change', function () { onFile(input.files && input.files[0]); });
    zone.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; zone.classList.add('is-dragover'); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    zone.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('is-dragover'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragover');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try { var dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch (err) { /* not critical */ }
      onFile(f);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  window.Vshare = {
    formatBytes: formatBytes,
    showStatus: showStatus,
    getConfig: getConfig,
    fillSelect: fillSelect,
    xhrUpload: xhrUpload,
    postJson: postJson,
    progress: progress,
    initCopyButtons: initCopyButtons,
    initDropzone: initDropzone,
  };
})();
