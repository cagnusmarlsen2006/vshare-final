/* Context-based (campus-locked) sharing page. */
(function () {
  'use strict';
  var V = window.Vshare;
  var $ = function (id) { return document.getElementById(id); };

  var fCampus = $('f-campus');
  var sCampus = $('s-campus');
  var file = null;
  var maxBytes = Infinity;
  var currentKey = '';
  var busy = false;
  var copyLive = $('copy-live');
  var prog = V.progress($('f-progress'));

  V.getConfig().then(function (cfg) {
    var campuses = cfg.campuses || ['Main Campus'];
    V.fillSelect(fCampus, campuses, campuses[0]);
    V.fillSelect(sCampus, campuses, campuses[0]);
    maxBytes = cfg.maxFileSizeBytes || Infinity;
    if (cfg.maxFileSizeBytes) $('f-size-hint').textContent = 'Any file type. Max ' + V.formatBytes(maxBytes) + '.';
    syncLabels();
  });

  function syncLabels() {
    $('f-campus-label').textContent = fCampus.value;
    $('s-campus-label').textContent = sCampus.value;
  }
  fCampus.addEventListener('change', function () {
    syncLabels();
    // A key belongs to one campus: changing campus needs a new key.
    if (currentKey) {
      currentKey = '';
      $('key-box').hidden = true;
      V.showStatus($('f-status'), 'Campus changed: generate a new key for ' + fCampus.value + '.', 'info');
    }
  });
  sCampus.addEventListener('change', syncLabels);

  /* ---------- Faculty: step 1 ---------- */
  $('gen-key').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    V.postJson('/api/context/keys', { campus: fCampus.value }).then(function (r) {
      btn.disabled = false;
      if (r.status !== 201) {
        V.showStatus($('f-status'), r.body.error || 'Could not generate a key.', 'error');
        return;
      }
      currentKey = r.body.key;
      $('access-key').value = currentKey;
      $('key-box').hidden = false;
      V.showStatus($('f-status'), 'Key generated for ' + r.body.campus + '. Now upload your file.', 'success');
    }).catch(function () {
      btn.disabled = false;
      V.showStatus($('f-status'), 'Network error. Please try again.', 'error');
    });
  });

  /* ---------- Faculty: step 2 ---------- */
  V.initDropzone($('f-drop'), $('f-file'), function (f) {
    file = f || null;
    var sel = $('f-selected');
    if (!file) { sel.hidden = true; return; }
    sel.textContent = file.name + ' · ' + V.formatBytes(file.size);
    sel.hidden = false;
    $('f-drop').classList.add('has-file');
    if (file.size > maxBytes) V.showStatus($('f-status'), 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.', 'error');
    else V.showStatus($('f-status'), '');
  });

  $('f-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var status = $('f-status');
    if (!currentKey) { V.showStatus(status, 'Step 1 first: generate an access key.', 'error'); $('gen-key').focus(); return; }
    if (!file) { V.showStatus(status, 'Choose a file to upload.', 'error'); return; }
    if (file.size > maxBytes) { V.showStatus(status, 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.', 'error'); return; }

    var data = new FormData(); // settings BEFORE the file
    data.append('campus', fCampus.value);
    data.append('access_key', currentKey);
    data.append('expiry', $('f-expiry').value);
    data.append('file', file, file.name);

    busy = true;
    $('f-upload').disabled = true;
    V.showStatus(status, '');
    prog.show();
    prog.set(0);
    V.xhrUpload('/api/context/upload', data, function (pct, done) { prog.set(pct, done ? 'Encrypting & storing…' : 'Uploading…'); })
      .then(function (r) {
        busy = false;
        $('f-upload').disabled = false;
        prog.hide();
        if (r.status !== 201) {
          V.showStatus(status, (r.body && r.body.error) || 'Upload failed (HTTP ' + r.status + ').', 'error');
          return;
        }
        $('f-result-key').value = currentKey;
        $('f-result-campus').textContent = r.body.campus;
        $('f-delete').value = location.origin + r.body.deletePath;
        $('f-form').hidden = true;
        $('key-box').hidden = true;
        $('gen-key').disabled = true;
        $('f-result').hidden = false;
        $('f-result').focus();
      })
      .catch(function () {
        busy = false;
        $('f-upload').disabled = false;
        prog.hide();
        V.showStatus(status, 'The upload failed: the connection was lost.', 'error');
      });
  });

  $('f-again').addEventListener('click', function () {
    currentKey = '';
    file = null;
    $('f-form').reset();
    $('f-selected').hidden = true;
    $('f-drop').classList.remove('has-file');
    $('f-result').hidden = true;
    $('f-form').hidden = false;
    $('gen-key').disabled = false;
    V.showStatus($('f-status'), '');
    $('gen-key').focus();
  });

  /* ---------- Student ---------- */
  var sForm = $('s-form');
  var verified = false;
  sForm.addEventListener('submit', function (e) {
    if (verified) return; // second pass: let the browser POST and download natively
    e.preventDefault();
    var status = $('s-status');
    var key = $('s-key').value.trim();
    if (!key) { V.showStatus(status, 'Paste your access key.', 'error'); $('s-key').focus(); return; }
    $('s-access').disabled = true;
    // Check first (uses nothing up), so errors show here instead of on a new page.
    V.postJson('/api/context/check', { campus: sCampus.value, key: key }).then(function (r) {
      $('s-access').disabled = false;
      if (r.status !== 200) {
        V.showStatus(status, r.body.error || 'Access denied.', 'error');
        return;
      }
      V.showStatus(status, 'Found "' + r.body.name + '" (' + V.formatBytes(r.body.size) + '). Download starting: this key is now used up.', 'success');
      verified = true;
      sForm.submit();
      setTimeout(function () { verified = false; $('s-key').value = ''; }, 1000);
    }).catch(function () {
      $('s-access').disabled = false;
      V.showStatus(status, 'Network error. Please try again.', 'error');
    });
  });

  V.initCopyButtons(document, copyLive);
})();
