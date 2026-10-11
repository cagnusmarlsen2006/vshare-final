/* Study-material distribution page. */
(function () {
  'use strict';
  var V = window.Vshare;
  var $ = function (id) { return document.getElementById(id); };
  var file = null;
  var maxBytes = Infinity;
  var materialType = '';
  var busy = false;
  var prog = V.progress($('d-progress'));
  var EXPIRY_LABELS = { '30d': '30 days', '90d': '90 days (a semester)', '180d': '180 days' };

  V.getConfig().then(function (cfg) {
    var depts = cfg.departments || [];
    var years = (cfg.years || []).map(function (y) { return [y, 'Year ' + y]; });
    V.fillSelect($('d-dept'), depts, depts[0]);
    V.fillSelect($('l-dept'), depts, depts[0]);
    V.fillSelect($('d-year'), years, '1');
    V.fillSelect($('l-year'), years, '1');
    V.fillSelect($('d-expiry'), (cfg.studyExpiryOptions || []).map(function (k) { return [k, EXPIRY_LABELS[k] || k]; }), cfg.defaultStudyExpiry);
    (cfg.materialTypes || []).forEach(function (t) {
      var o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      $('l-type').appendChild(o);
    });
    buildTypeChips(cfg.materialTypes || []);
    maxBytes = cfg.maxFileSizeBytes || Infinity;
    syncTarget();
  });

  function syncTarget() {
    $('d-target').textContent = $('d-dept').value + ' · Year ' + $('d-year').value;
  }
  $('d-dept').addEventListener('change', syncTarget);
  $('d-year').addEventListener('change', syncTarget);

  // Material type: accessible radio chips (arrow keys move, like native radios).
  function buildTypeChips(types) {
    var group = $('d-types');
    types.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-radio';
      b.setAttribute('role', 'radio');
      b.textContent = t;
      b.dataset.value = t;
      b.addEventListener('click', function () { select(i); });
      b.addEventListener('keydown', function (e) {
        var n = types.length;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select((i + 1) % n, true); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select((i - 1 + n) % n, true); }
      });
      group.appendChild(b);
    });
    select(0);
    function select(idx, focus) {
      Array.prototype.forEach.call(group.children, function (c, j) {
        var on = j === idx;
        c.setAttribute('aria-checked', String(on));
        c.tabIndex = on ? 0 : -1;
        if (on) { materialType = c.dataset.value; if (focus) c.focus(); }
      });
    }
  }

  V.initDropzone($('d-drop'), $('d-file'), function (f) {
    file = f || null;
    var sel = $('d-selected');
    if (!file) { sel.hidden = true; return; }
    sel.textContent = file.name + ' · ' + V.formatBytes(file.size);
    sel.hidden = false;
    $('d-drop').classList.add('has-file');
    V.showStatus($('d-status'), file.size > maxBytes ? 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.' : '', 'error');
  });

  $('d-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var status = $('d-status');
    var subject = $('d-subject').value.trim();
    if (subject.length < 2) { V.showStatus(status, 'Enter the subject.', 'error'); $('d-subject').focus(); return; }
    if (!file) { V.showStatus(status, 'Choose a file to distribute.', 'error'); return; }
    if (file.size > maxBytes) { V.showStatus(status, 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.', 'error'); return; }

    var data = new FormData(); // settings BEFORE the file
    data.append('department', $('d-dept').value);
    data.append('year', $('d-year').value);
    data.append('subject', subject);
    data.append('material_type', materialType);
    data.append('expiry', $('d-expiry').value);
    data.append('file', file, file.name);

    busy = true;
    $('d-submit').disabled = true;
    V.showStatus(status, '');
    prog.show();
    prog.set(0);
    V.xhrUpload('/api/study/upload', data, function (pct, done) { prog.set(pct, done ? 'Encrypting & tagging…' : 'Uploading…'); })
      .then(function (r) {
        busy = false;
        $('d-submit').disabled = false;
        prog.hide();
        if (r.status !== 201) {
          V.showStatus(status, (r.body && r.body.error) || 'Upload failed (HTTP ' + r.status + ').', 'error');
          return;
        }
        var kw = r.body.keywords && r.body.keywords.length ? ' Keywords: ' + r.body.keywords.join(', ') + '.' : '';
        V.showStatus(status, '"' + r.body.name + '" was distributed to ' + r.body.department + ' · Year ' + r.body.year + '.' + kw, 'success');
        $('d-form').reset();
        file = null;
        $('d-selected').hidden = true;
        $('d-drop').classList.remove('has-file');
        syncTarget();
        // Show the class list the material went to.
        $('l-dept').value = r.body.department;
        $('l-year').value = r.body.year;
        loadList();
      })
      .catch(function () {
        busy = false;
        $('d-submit').disabled = false;
        prog.hide();
        V.showStatus(status, 'The upload failed: the connection was lost.', 'error');
      });
  });

  /* ---------- Students ---------- */
  function loadList() {
    var status = $('l-status');
    var list = $('l-list');
    var url = '/api/study/materials?department=' + encodeURIComponent($('l-dept').value) + '&year=' + encodeURIComponent($('l-year').value);
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (r) {
        list.textContent = '';
        if (r.status !== 200) { V.showStatus(status, r.body.error || 'Could not load materials.', 'error'); return; }
        var type = $('l-type').value;
        var items = r.body.materials.filter(function (m) { return !type || m.materialType === type; });
        V.showStatus(status, items.length + ' item' + (items.length === 1 ? '' : 's') + ' for ' + r.body.department + ' · Year ' + r.body.year + '.', items.length ? 'info' : 'info');
        items.forEach(function (m) { list.appendChild(renderItem(m)); });
      })
      .catch(function () { V.showStatus(status, 'Network error. Please try again.', 'error'); });
  }

  function renderItem(m) {
    var li = document.createElement('li');
    li.className = 'material';
    var head = document.createElement('div');
    head.className = 'material-head';
    var type = document.createElement('span');
    type.className = 'chip chip-peach';
    type.textContent = m.materialType;
    var subj = document.createElement('span');
    subj.className = 'material-subject';
    subj.textContent = m.subject;
    head.appendChild(type);
    head.appendChild(subj);
    var name = document.createElement('p');
    name.className = 'material-name';
    name.textContent = m.name + ' · ' + V.formatBytes(m.size) + ' · added ' + new Date(m.uploadedAt).toLocaleDateString();
    li.appendChild(head);
    li.appendChild(name);
    if (m.keywords && m.keywords.length) {
      var kw = document.createElement('p');
      kw.className = 'keywords';
      kw.textContent = 'Keywords: ' + m.keywords.join(', ');
      li.appendChild(kw);
    }
    var a = document.createElement('a');
    a.className = 'clay-button primary';
    a.href = m.path;
    a.textContent = 'Open download page';
    li.appendChild(a);
    return li;
  }

  $('l-form').addEventListener('submit', function (e) { e.preventDefault(); loadList(); });
})();
