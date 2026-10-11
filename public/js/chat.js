/* Vshare help chatbot widget (bottom-right). Talks to POST /api/chat; nothing is stored. */
(function () {
  'use strict';

  var open = false;
  var greeted = false;

  var fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'chat-fab';
  fab.setAttribute('aria-label', 'Open help chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'chat-panel');
  fab.innerHTML = '<span class="chat-fab-icon" aria-hidden="true"></span>';

  var panel = document.createElement('section');
  panel.className = 'chat-panel';
  panel.id = 'chat-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'chat-title');
  panel.innerHTML =
    '<header class="chat-head"><h2 id="chat-title">Vshare helper</h2>' +
    '<button type="button" class="chat-close" aria-label="Close help chat">×</button></header>' +
    '<div class="chat-log" aria-live="polite" aria-relevant="additions"></div>' +
    '<div class="chat-suggestions" aria-label="Suggested questions"></div>' +
    '<form class="chat-form"><label class="sr-only" for="chat-input">Your question</label>' +
    '<input id="chat-input" class="clay-input" type="text" maxlength="500" autocomplete="off" placeholder="Ask a question…">' +
    '<button class="clay-button primary" type="submit">Send</button></form>' +
    '<p class="chat-note">Offline helper bot: answers come from this app, nothing is stored.</p>';

  document.body.appendChild(panel);
  document.body.appendChild(fab);

  var log = panel.querySelector('.chat-log');
  var suggestions = panel.querySelector('.chat-suggestions');
  var form = panel.querySelector('.chat-form');
  var input = panel.querySelector('#chat-input');

  function addMessage(text, who, links) {
    var msg = document.createElement('div');
    msg.className = 'chat-msg chat-' + who;
    var p = document.createElement('p');
    p.textContent = text;
    msg.appendChild(p);
    (links || []).forEach(function (l) {
      if (!/^\/[\w./-]*$/.test(l.href)) return; // internal links only
      var a = document.createElement('a');
      a.href = l.href;
      a.className = 'chat-link';
      a.textContent = l.label + ' →';
      msg.appendChild(a);
    });
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  }

  function setSuggestions(list) {
    suggestions.textContent = '';
    (list || []).forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-button';
      b.textContent = s;
      b.addEventListener('click', function () { ask(s); });
      suggestions.appendChild(b);
    });
  }

  function ask(text) {
    var q = String(text || '').trim();
    if (!q) return;
    addMessage(q, 'user');
    input.value = '';
    var typing = document.createElement('div');
    typing.className = 'chat-msg chat-bot chat-typing';
    typing.textContent = '…';
    log.appendChild(typing);
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ message: q }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        typing.remove();
        addMessage(res.reply || res.error || 'Sorry, something went wrong.', 'bot', res.links);
        setSuggestions(res.suggestions);
      })
      .catch(function () {
        typing.remove();
        addMessage('I could not reach the server. Please try again.', 'bot');
      });
  }

  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open;
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    fab.classList.toggle('is-open', open);
    if (open) {
      if (!greeted) {
        greeted = true;
        addMessage('Hi! I can help with sharing files, campus keys, study materials and fake-news verification. What would you like to know?', 'bot');
        setSuggestions(['How do I share a file?', 'How do campus keys work?', 'How does fake news detection work?']);
      }
      input.focus();
    } else {
      fab.focus();
    }
  }

  fab.addEventListener('click', function () { toggle(); });
  panel.querySelector('.chat-close').addEventListener('click', function () { toggle(false); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
})();
