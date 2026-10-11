/* Vshare download page: live countdown + friendly button state. */
(function () {
  'use strict';

  var badge = document.getElementById('countdown');
  var form = document.getElementById('download-form');
  var statusBox = document.getElementById('form-status');

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function render(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + pad(m) + 'm';
    if (h > 0) return h + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    return pad(m) + ':' + pad(sec);
  }

  if (badge) {
    var expiresAt = Number(badge.getAttribute('data-expires-at'));
    var value = badge.querySelector('.countdown-value');
    var timer = null;
    var tick = function () {
      var left = expiresAt - Date.now();
      if (left <= 0) {
        value.textContent = 'expired';
        badge.classList.remove('is-urgent');
        if (form) {
          Array.prototype.forEach.call(form.querySelectorAll('button, input'), function (el) { el.disabled = true; });
        }
        statusBox.innerHTML = '';
        var div = document.createElement('div');
        div.className = 'alert alert-info';
        div.textContent = 'This file just self-destructed.';
        statusBox.appendChild(div);
        clearInterval(timer);
        return;
      }
      value.textContent = render(left);
      if (left < 60 * 1000) badge.classList.add('is-urgent');
    };
    // Screen readers: announce only when asked, not every second.
    badge.setAttribute('aria-live', 'off');
    tick();
    timer = setInterval(tick, 1000);
  }

  if (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type="submit"]');
      if (!btn) return;
      // The browser streams the file natively; we just give feedback.
      setTimeout(function () {
        btn.disabled = true;
        btn.textContent = 'Starting download…';
      }, 0);
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = 'Download';
      }, 5000);
    });
  }
})();
