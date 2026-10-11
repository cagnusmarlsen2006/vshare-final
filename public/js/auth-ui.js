/* Header sign-in state + gating of upload forms.
   The server enforces access; this only explains it nicely. */
(function () {
  'use strict';

  function initials(name, email) {
    var src = String(name || email || '?').trim();
    var parts = src.split(/[\s._@-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function signInHref() {
    return '/auth/google?returnTo=' + encodeURIComponent(location.pathname);
  }

  function googleButton(label) {
    var a = document.createElement('a');
    a.className = 'google-btn';
    a.href = signInHref();
    a.innerHTML = '<span class="google-g" aria-hidden="true">G</span><span></span>';
    a.lastChild.textContent = label || 'Sign in with Google';
    return a;
  }

  function renderHeader(state) {
    var tools = window.vshareHeaderTools ? window.vshareHeaderTools() : null;
    if (!tools || !state.authEnabled) return;
    var slot = document.createElement('div');
    slot.className = 'auth-slot';
    if (state.user) {
      var u = state.user;
      var who = document.createElement('div');
      who.className = 'user-chip';
      var av = document.createElement('span');
      av.className = 'avatar';
      av.setAttribute('aria-hidden', 'true');
      av.textContent = initials(u.name, u.email);
      var txt = document.createElement('span');
      txt.className = 'user-text';
      var nm = document.createElement('span');
      nm.className = 'user-name';
      nm.textContent = u.name || u.email;
      var role = document.createElement('span');
      role.className = 'role-badge role-' + u.role;
      role.textContent = u.role === 'faculty' ? 'Faculty' : 'Student';
      txt.appendChild(nm);
      txt.appendChild(role);
      who.appendChild(av);
      who.appendChild(txt);
      who.title = u.email;
      var form = document.createElement('form');
      form.method = 'post';
      form.action = '/auth/logout';
      form.className = 'logout-form';
      var out = document.createElement('button');
      out.type = 'submit';
      out.className = 'clay-button small';
      out.textContent = 'Sign out';
      form.appendChild(out);
      slot.appendChild(who);
      slot.appendChild(form);
    } else {
      slot.appendChild(googleButton());
    }
    tools.appendChild(slot);
  }

  /** Elements with data-requires="user|faculty" get an explanatory gate when access is missing. */
  function gate(state) {
    if (!state.authEnabled) return;
    var needs = document.querySelectorAll('[data-requires]');
    Array.prototype.forEach.call(needs, function (el) {
      var need = el.getAttribute('data-requires');
      var user = state.user;
      var ok = need === 'user' ? Boolean(user) : Boolean(user && user.role === 'faculty');
      if (ok) return;
      var box = document.createElement('div');
      box.className = 'auth-gate';
      box.setAttribute('role', 'note');
      var p = document.createElement('p');
      if (!user) {
        p.textContent = need === 'faculty' ? 'Faculty sign-in required for this section.' : 'Sign in with Google to upload files.';
        box.appendChild(p);
        box.appendChild(googleButton());
      } else {
        p.textContent = 'You are signed in as a student. This section is for faculty accounts.';
        box.appendChild(p);
      }
      el.classList.add('is-gated');
      // Everything except the notice becomes inert (also covers controls added later).
      Array.prototype.forEach.call(el.children, function (child) {
        child.inert = true;
        child.setAttribute('aria-disabled', 'true');
      });
      el.insertBefore(box, el.firstChild);
    });
    // Signed-out-only / signed-in-only content (e.g. the home page call to action).
    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-show]'), function (el) {
      var want = el.getAttribute('data-auth-show');
      el.hidden = want === 'signed-out' ? Boolean(state.user) : !state.user;
    });
  }

  fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { authEnabled: false, user: null }; })
    .catch(function () { return { authEnabled: false, user: null }; })
    .then(function (state) {
      window.VshareAuth = state;
      renderHeader(state);
      gate(state);
    });
})();
