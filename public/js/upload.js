/* Vshare upload page. Vanilla JS, no dependencies. */
(function () {
  'use strict';

  var form = document.getElementById('upload-form');
  var input = document.getElementById('file-input');
  var dropzone = document.getElementById('dropzone');
  var selected = document.getElementById('selected-file');
  var statusBox = document.getElementById('upload-status');
  var button = document.getElementById('upload-button');
  var progress = document.getElementById('progress');
  var progressBar = document.getElementById('progress-bar');
  var progressFill = document.getElementById('progress-fill');
  var progressPct = document.getElementById('progress-pct');
  var progressLabel = document.getElementById('progress-label');
  var uploadCard = document.getElementById('upload-card');
  var resultCard = document.getElementById('result-card');
  var copyStatus = document.getElementById('copy-status');

  var maxBytes = 10 * 1024 * 1024;
  var file = null;
  var busy = false;

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  function showStatus(message, kind) {
    statusBox.textContent = '';
    if (!message) return;
    var div = document.createElement('div');
    div.className = 'alert alert-' + (kind || 'error');
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.textContent = message;
    statusBox.appendChild(div);
  }

  function setProgress(pct, label) {
    var p = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = p + '%';
    progressBar.setAttribute('aria-valuenow', String(p));
    progressPct.textContent = p + '%';
    if (label) progressLabel.firstChild.textContent = label + ' ';
  }

  // Server-side limit (single source of truth: config.js).
  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;
      maxBytes = cfg.maxFileSizeBytes;
      document.getElementById('max-size').textContent = formatBytes(maxBytes);
    })
    .catch(function () { /* keep defaults */ });

  function chooseFile(f) {
    file = f || null;
    showStatus('');
    if (!file) {
      selected.hidden = true;
      dropzone.classList.remove('has-file');
      return;
    }
    selected.textContent = file.name + ' · ' + formatBytes(file.size);
    selected.hidden = false;
    dropzone.classList.add('has-file');
    if (file.size > maxBytes) {
      showStatus('"' + file.name + '" is ' + formatBytes(file.size) + '. The maximum is ' + formatBytes(maxBytes) + '.', 'error');
    }
  }

  input.addEventListener('change', function () {
    chooseFile(input.files && input.files[0]);
  });

  // Drag and drop: the tray "inflates" while a file hovers over it.
  var depth = 0;
  dropzone.addEventListener('dragenter', function (e) {
    e.preventDefault();
    depth++;
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', function () {
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropzone.classList.remove('is-dragover');
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    depth = 0;
    dropzone.classList.remove('is-dragover');
    if (busy) return;
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (files.length > 1) showStatus('Only one file at a time: using the first one.', 'info');
    try {
      // Keep the input in sync (supported in modern browsers).
      var dt = new DataTransfer();
      dt.items.add(files[0]);
      input.files = dt.files;
    } catch (err) { /* not critical */ }
    chooseFile(files[0]);
  });
  // Dropping outside the tray must not navigate away from the page.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  function setBusy(on) {
    busy = on;
    button.disabled = on;
    input.disabled = on;
    Array.prototype.forEach.call(form.querySelectorAll('select, input[type="password"]'), function (el) {
      el.disabled = on;
    });
    button.textContent = on ? 'Uploading…' : 'Encrypt & upload';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    if (!file) {
      showStatus('Choose a file first: drag it onto the tray or press Enter on it to browse.', 'error');
      input.focus();
      return;
    }
    if (file.size > maxBytes) {
      showStatus('This file is too large. The maximum is ' + formatBytes(maxBytes) + '.', 'error');
      return;
    }

    // Settings MUST come before the file: the server streams the file
    // straight into encryption and rejects settings that arrive late.
    var data = new FormData();
    data.append('expiry', form.elements.expiry.value);
    data.append('max_downloads', form.elements.max_downloads.value);
    data.append('password', form.elements.password.value);
    data.append('file', file, file.name);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';

    xhr.upload.addEventListener('progress', function (ev) {
      if (ev.lengthComputable) setProgress((ev.loaded / ev.total) * 100, 'Uploading…');
    });
    xhr.upload.addEventListener('load', function () {
      setProgress(100, 'Encrypting & storing…');
    });

    xhr.addEventListener('load', function () {
      var body = null;
      try { body = JSON.parse(xhr.responseText); } catch (err) { body = null; }
      if (xhr.status === 201 && body) {
        showResult(body);
        return;
      }
      var msg = (body && body.error) || 'Upload failed (HTTP ' + xhr.status + '). Please try again.';
      if (xhr.status === 413 && !(body && body.error)) msg = 'This file is too large. The maximum is ' + formatBytes(maxBytes) + '.';
      if (xhr.status === 429) msg = (body && body.error) || 'Too many uploads. Please wait a few minutes.';
      failUpload(msg);
    });
    xhr.addEventListener('error', function () {
      failUpload('The upload failed: the connection was lost. Check your network and try again.');
    });
    xhr.addEventListener('timeout', function () {
      failUpload('The upload timed out. Please try again.');
    });

    showStatus('');
    progress.hidden = false;
    setProgress(0, 'Uploading…');
    setBusy(true);
    xhr.send(data);
  });

  function failUpload(message) {
    setBusy(false);
    progress.hidden = true;
    showStatus(message, 'error');
  }

  function showResult(info) {
    var origin = window.location.origin;
    document.getElementById('share-link').value = origin + info.sharePath;
    document.getElementById('delete-link').value = origin + info.deletePath;

    var parts = [];
    parts.push('"' + info.name + '" (' + formatBytes(info.size) + ') self-destructs on ' +
      new Date(info.expiresAt).toLocaleString());
    if (info.maxDownloads) {
      parts.push('or after ' + info.maxDownloads + ' download' + (info.maxDownloads === 1 ? '' : 's') + ', whichever comes first');
    }
    var summary = parts.join(' ') + '.';
    if (info.passwordProtected) summary += ' Password protected: share the password separately.';
    document.getElementById('result-summary').textContent = summary;

    setBusy(false);
    uploadCard.hidden = true;
    resultCard.hidden = false;
    resultCard.focus();
  }

  // Copy buttons with a little success pop.
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy-target]'), function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-copy-target'));
      var text = target.value;
      var done = function () {
        btn.textContent = 'Copied!';
        btn.classList.remove('copied');
        void btn.offsetWidth; // restart the animation
        btn.classList.add('copied');
        copyStatus.textContent = 'Link copied to clipboard';
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
          copyStatus.textContent = '';
        }, 1800);
      };
      var fallback = function () {
        target.focus();
        target.select();
        try {
          if (document.execCommand('copy')) { done(); return; }
        } catch (err) { /* ignore */ }
        copyStatus.textContent = 'Press Ctrl+C (or Cmd+C) to copy the selected link';
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    });
  });

  document.getElementById('again-button').addEventListener('click', function () {
    form.reset();
    chooseFile(null);
    progress.hidden = true;
    setProgress(0);
    document.getElementById('share-link').value = '';
    document.getElementById('delete-link').value = '';
    resultCard.hidden = true;
    uploadCard.hidden = false;
    input.focus();
  });
})();
