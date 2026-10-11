/* Fake-news-proof sharing page: upload, then render the credibility report. */
(function () {
  'use strict';
  var V = window.Vshare;
  var $ = function (id) { return document.getElementById(id); };
  var file = null;
  var maxBytes = 10 * 1024 * 1024;
  var busy = false;
  var prog = V.progress($('v-progress'));
  var ENTITY_LABELS = {
    PERSON: 'People', ORGANIZATION: 'Organisations', PLACE: 'Places', DATE: 'Dates',
    MONEY: 'Money', PERCENT: 'Percentages', EMAIL: 'Emails', URL: 'Links',
  };

  V.getConfig().then(function (cfg) {
    if (cfg.verifyMaxBytes) {
      maxBytes = cfg.verifyMaxBytes;
      $('v-hint').textContent = 'PDF, DOCX, PPTX, TXT, HTML · up to ' + V.formatBytes(maxBytes);
    }
  });

  V.initDropzone($('v-drop'), $('v-file'), function (f) {
    file = f || null;
    var sel = $('v-selected');
    if (!file) { sel.hidden = true; return; }
    sel.textContent = file.name + ' · ' + V.formatBytes(file.size);
    sel.hidden = false;
    $('v-drop').classList.add('has-file');
    V.showStatus($('v-status'), file.size > maxBytes ? 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.' : '', 'error');
  });

  $('v-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var status = $('v-status');
    if (!file) { V.showStatus(status, 'Choose a document to verify.', 'error'); return; }
    if (file.size > maxBytes) { V.showStatus(status, 'This file is too large. The maximum is ' + V.formatBytes(maxBytes) + '.', 'error'); return; }

    var data = new FormData(); // settings BEFORE the file
    data.append('source_url', $('v-source').value.trim());
    data.append('trusted_domains', $('v-trusted').value.trim());
    data.append('expiry', $('v-expiry').value);
    data.append('file', file, file.name);

    busy = true;
    $('v-submit').disabled = true;
    V.showStatus(status, '');
    prog.show();
    prog.set(0);
    V.xhrUpload('/api/verify/upload', data, function (pct, done) { prog.set(pct, done ? 'Analysing (NER, text mining, ML)…' : 'Uploading…'); })
      .then(function (r) {
        busy = false;
        $('v-submit').disabled = false;
        prog.hide();
        if (r.body && r.body.report) {
          renderReport(r.body, r.status === 201);
          return;
        }
        V.showStatus(status, (r.body && r.body.error) || 'Verification failed (HTTP ' + r.status + ').', 'error');
      })
      .catch(function () {
        busy = false;
        $('v-submit').disabled = false;
        prog.hide();
        V.showStatus(status, 'The upload failed: the connection was lost.', 'error');
      });
  });

  function li(text) {
    var el = document.createElement('li');
    el.textContent = text;
    return el;
  }

  function renderReport(body, shared) {
    var rep = body.report;
    var box = $('report');
    box.classList.remove('is-credible', 'is-uncertain', 'is-likely-fake');
    box.classList.add('is-' + rep.verdict);
    $('r-score').textContent = rep.credibility;
    $('r-meter').style.width = rep.credibility + '%';
    var label = { credible: 'Credible: shared', uncertain: 'Uncertain: not shared', 'likely-fake': 'Likely fake: not shared' }[rep.verdict];
    $('r-title').textContent = label;
    $('r-verdict-text').textContent = shared
      ? 'The document passed the credibility check.'
      : (body.error || 'The document was not shared and has been deleted.');

    $('r-share').hidden = !shared;
    if (shared) {
      $('r-link').value = location.origin + body.sharePath;
      $('r-delete').value = location.origin + body.deletePath;
    }

    var reasons = $('r-reasons');
    reasons.textContent = '';
    rep.reasons.forEach(function (r) { reasons.appendChild(li(r)); });

    var ml = rep.components.ml;
    var terms = $('r-terms');
    terms.textContent = '';
    if (ml) {
      $('r-ml').textContent = 'Probability of fake news: ' + Math.round(ml.probabilityFake * 100) + '% (' + ml.knownFeatures + ' known features). Most influential terms:';
      ml.topTerms.forEach(function (t) {
        var el = li(t.term + ' → ' + t.pushesTowards);
        el.className = t.pushesTowards === 'FAKE' ? 'term-fake' : 'term-real';
        terms.appendChild(el);
      });
    } else {
      $('r-ml').textContent = 'Not enough readable text for the model (' + rep.extraction.words + ' words via ' + rep.extraction.method + ').';
    }

    var s = rep.components.style.signals;
    var style = $('r-style');
    style.textContent = '';
    [
      ['Style score', rep.components.style.score + '/100'],
      ['Words / sentences', s.words + ' / ' + s.sentences],
      ['Sensational terms', s.sensationalTerms],
      ['Exclamation marks', s.exclamations],
      ['ALL-CAPS words', Math.round(s.capsWordRatio * 100) + '%'],
      ['Attribution phrases', s.attributionTerms],
      ['Readability (Flesch)', s.readability === null ? 'n/a' : s.readability],
    ].forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = String(row[1]);
      style.appendChild(dt);
      style.appendChild(dd);
    });

    var src = rep.components.source;
    $('r-source').textContent = src.provided
      ? (src.domain || src.url || '') + ': ' + src.category.replace(/-/g, ' ') + (src.score !== null ? ' (score ' + Math.round(src.score * 100) + '/100)' : '')
      : 'No source URL given: add one to raise confidence.';

    $('r-keywords').textContent = rep.keywords.length ? rep.keywords.join(', ') : 'n/a';
    $('r-summary').textContent = rep.summary.length ? rep.summary.join(' ') : 'n/a';

    var groups = {};
    rep.entities.forEach(function (e) { (groups[e.type] = groups[e.type] || []).push(e); });
    var ent = $('r-entities');
    ent.textContent = '';
    Object.keys(ENTITY_LABELS).forEach(function (type) {
      if (!groups[type]) return;
      var g = document.createElement('div');
      g.className = 'entity-group';
      var h = document.createElement('h4');
      h.textContent = ENTITY_LABELS[type];
      g.appendChild(h);
      groups[type].forEach(function (e) {
        var c = document.createElement('span');
        c.className = 'chip entity entity-' + type.toLowerCase();
        c.textContent = e.text + (e.count > 1 ? ' ×' + e.count : '');
        g.appendChild(c);
      });
      ent.appendChild(g);
    });
    if (!ent.children.length) ent.textContent = 'No named entities found.';

    $('r-model').textContent = 'Model: ' + rep.model.type + ', test accuracy ' + (rep.model.testAccuracy * 100).toFixed(1) + '% on ' + rep.model.dataset + '. ' + rep.model.note;

    $('v-card').hidden = true;
    box.hidden = false;
    box.focus();
    V.initCopyButtons(box, $('copy-live'));
  }

  $('r-again').addEventListener('click', function () {
    $('report').hidden = true;
    $('v-card').hidden = false;
    $('v-form').reset();
    file = null;
    $('v-selected').hidden = true;
    $('v-drop').classList.remove('has-file');
    V.showStatus($('v-status'), '');
    $('v-file').focus();
  });
})();
