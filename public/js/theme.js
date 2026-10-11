/* Theme: loaded in <head> (not deferred) so the saved theme applies before first paint.
   Default follows the OS (prefers-color-scheme); the toggle stores an explicit choice. */
(function () {
  'use strict';
  var KEY = 'vshare-theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);

  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function current() {
    var explicit = root.getAttribute('data-theme');
    if (explicit === 'light' || explicit === 'dark') return explicit;
    return mq && mq.matches ? 'dark' : 'light';
  }

  /** Shared slot on the right of the header (auth-ui.js uses it too). */
  window.vshareHeaderTools = function () {
    var header = document.querySelector('.site-header');
    if (!header) return null;
    var tools = header.querySelector('.header-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'header-tools';
      header.appendChild(tools);
    }
    return tools;
  };

  document.addEventListener('DOMContentLoaded', function () {
    var tools = window.vshareHeaderTools();
    if (!tools) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.innerHTML = '<span class="theme-icon" aria-hidden="true"></span>';
    function sync() {
      var dark = current() === 'dark';
      var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: still works for this page */ }
      sync();
    });
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', sync);
      else if (mq.addListener) mq.addListener(sync);
    }
    sync();
    tools.insertBefore(btn, tools.firstChild);
  });
})();
