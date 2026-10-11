'use strict';

/**
 * Google sign-in + JWT session tests, against a local FAKE Google
 * (authorization, token and JWKS endpoints) with a real RSA signing key.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, request, multipart } = require('./helpers');
const { signJwt } = require('../src/auth');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-secret';
const JWT_SECRET = 'test-jwt-secret-0123456789abcdef';

/* ---------------- fake Google ---------------- */
function startFakeGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // for forged signatures
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map(); // code -> { claims, challenge, sign }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims, key = privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
    const data = `${b64(header)}.${b64(claims)}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/certs') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const entry = codes.get(p.get('code'));
        const challengeOk = entry && crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') === entry.challenge;
        res.setHeader('Content-Type', 'application/json');
        if (!entry || !challengeOk || p.get('client_secret') !== CLIENT_SECRET || p.get('grant_type') !== 'authorization_code') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        codes.delete(p.get('code'));
        res.end(JSON.stringify({ access_token: 'x', id_token: entry.idToken(entry.claims) }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, codes, sign, otherKey: other.privateKey, close: () => new Promise((r) => server.close(r)) });
  }));
}

let google;
let srv;
before(async () => {
  google = await startFakeGoogle();
  srv = await startServer({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    TEST_GOOGLE_BASE_URL: google.base,
    JWT_SECRET,
    FACULTY_EMAILS: '@college.edu, prof@gmail.com',
    ALLOWED_EMAIL_DOMAINS: 'college.edu, gmail.com',
  });
});
after(async () => {
  await srv.stop();
  await google.close();
});

const getCookie = (res, name) => {
  const list = [].concat(res.headers['set-cookie'] || []);
  const c = list.find((x) => x.startsWith(`${name}=`));
  return c ? { raw: c, value: decodeURIComponent(c.split(';')[0].slice(name.length + 1)) } : null;
};

/**
 * Run the OAuth flow. `tweak(claims)` can alter the ID-token claims; `idToken` can
 * replace the signer (for forged tokens). Returns the callback response.
 */
async function signIn(email, { returnTo = '/verify.html', tweak = (c) => c, idToken, badState = false, noFlowCookie = false } = {}) {
  const start = await request(srv.port, { path: `/auth/google?returnTo=${encodeURIComponent(returnTo)}` });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.location);
  const flow = getCookie(start, 'vs_oauth');
  const q = Object.fromEntries(loc.searchParams);
  const code = crypto.randomBytes(8).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const claims = tweak({
    iss: google.base, aud: CLIENT_ID, sub: `sub-${email}`, email, email_verified: true,
    name: email.split('@')[0], nonce: q.nonce, iat: now, exp: now + 3600,
  });
  google.codes.set(code, { claims, challenge: q.code_challenge, idToken: idToken || ((c) => google.sign(c)) });
  const cb = await request(srv.port, {
    path: `/auth/google/callback?code=${code}&state=${badState ? 'nope' : q.state}`,
    headers: noFlowCookie ? {} : { Cookie: `vs_oauth=${encodeURIComponent(flow.value)}` },
  });
  return { start, loc, q, cb, session: getCookie(cb, 'vs_session') };
}

const me = async (cookie) => JSON.parse((await request(srv.port, {
  path: '/api/me', headers: cookie ? { Cookie: `vs_session=${encodeURIComponent(cookie)}` } : {},
})).body);

async function upload(p, fields, cookie, data = Buffer.from('hello world, this is a test upload')) {
  const { body, contentType } = multipart([...fields.map(([name, value]) => ({ name, value })), { name: 'file', filename: 't.txt', data }]);
  const res = await request(srv.port, {
    method: 'POST', path: p, body,
    headers: {
      'Content-Type': contentType, 'Content-Length': body.length, Accept: 'application/json',
      ...(cookie ? { Cookie: `vs_session=${encodeURIComponent(cookie)}` } : {}),
    },
  });
  return { status: res.status, json: JSON.parse(res.body || '{}') };
}

async function postJson(p, data, cookie) {
  const body = JSON.stringify(data);
  const res = await request(srv.port, {
    method: 'POST', path: p, body,
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json',
      ...(cookie ? { Cookie: `vs_session=${encodeURIComponent(cookie)}` } : {}),
    },
  });
  return { status: res.status, json: JSON.parse(res.body || '{}') };
}

describe('Google sign-in flow', () => {
  it('starts with state, nonce and a PKCE S256 challenge, in a short-lived HttpOnly cookie', async () => {
    const start = await request(srv.port, { path: '/auth/google' });
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.location);
    assert.equal(loc.origin + loc.pathname, `${google.base}/o/oauth2/v2/auth`);
    const q = Object.fromEntries(loc.searchParams);
    assert.equal(q.client_id, CLIENT_ID);
    assert.equal(q.redirect_uri, 'http://localhost:3000/auth/google/callback');
    assert.equal(q.scope, 'openid email profile');
    assert.equal(q.code_challenge_method, 'S256');
    assert.ok(q.state.length >= 30 && q.nonce.length >= 30 && q.code_challenge.length >= 40);
    const flow = getCookie(start, 'vs_oauth');
    assert.match(flow.raw, /HttpOnly/);
    assert.match(flow.raw, /SameSite=Lax/);
    assert.match(flow.raw, /Path=\/auth/);
  });

  it('a student signs in: verified ID token -> JWT session cookie -> redirect back', async () => {
    const { cb, session } = await signIn('student@gmail.com');
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.location, '/verify.html');
    assert.ok(session, 'session cookie set');
    assert.match(session.raw, /HttpOnly/);
    assert.match(session.raw, /SameSite=Lax/);
    assert.equal(session.value.split('.').length, 3);
    const m = await me(session.value);
    assert.equal(m.authEnabled, true);
    assert.deepEqual({ email: m.user.email, role: m.user.role }, { email: 'student@gmail.com', role: 'student' });
  });

  it('faculty by exact email and by @domain', async () => {
    assert.equal((await me((await signIn('prof@gmail.com')).session.value)).user.role, 'faculty');
    assert.equal((await me((await signIn('dean@college.edu')).session.value)).user.role, 'faculty');
  });

  it('never redirects off-site after sign-in (open-redirect protection)', async () => {
    for (const bad of ['//evil.com/x', 'https://evil.com', '/\\evil.com']) {
      const { cb } = await signIn('student@gmail.com', { returnTo: bad });
      assert.equal(cb.headers.location, '/', bad);
    }
  });
});

describe('ID-token and flow attacks are rejected', () => {
  const rejected = async (opts, status) => {
    const { cb, session } = await signIn(opts.email || 'student@gmail.com', opts);
    assert.equal(cb.status, status, cb.body.toString().slice(0, 200));
    assert.equal(session, null, 'no session cookie');
    assert.doesNotMatch(cb.body.toString(), /at .*\.js:\d+/); // no stack traces
  };
  it('state mismatch (CSRF)', () => rejected({ badState: true }, 400));
  it('missing flow cookie', () => rejected({ noFlowCookie: true }, 400));
  it('forged signature', () => rejected({ idToken: (c) => google.sign(c, google.otherKey) }, 401));
  it('alg "none" ID token', () => rejected({
    idToken: (c) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.`,
  }, 401));
  it('wrong audience (token issued to another app)', () => rejected({ tweak: (c) => ({ ...c, aud: 'other-app' }) }, 401));
  it('wrong issuer', () => rejected({ tweak: (c) => ({ ...c, iss: 'https://evil.example' }) }, 401));
  it('expired ID token', () => rejected({ tweak: (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }) }, 401));
  it('nonce mismatch (replayed token)', () => rejected({ tweak: (c) => ({ ...c, nonce: 'replayed' }) }, 401));
  it('unverified email', () => rejected({ tweak: (c) => ({ ...c, email_verified: false }) }, 403));
  it('email domain not allowed', () => rejected({ email: 'someone@yahoo.com' }, 403));
});

describe('JWT sessions', () => {
  const now = () => Math.floor(Date.now() / 1000);
  it('a tampered payload (role upgraded) is ignored', async () => {
    const { session } = await signIn('student@gmail.com');
    const [h, p, s] = session.value.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    payload.role = 'faculty';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    assert.equal((await me(forged)).user, null);
    assert.equal((await postJson('/api/context/keys', { campus: 'Main Campus' }, forged)).status, 401);
  });

  it('alg "none" session tokens are ignored', async () => {
    const t = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({
      typ: 'session', iss: 'vshare', sub: 'x', email: 'a@college.edu', role: 'faculty', exp: now() + 3600,
    })).toString('base64url')}.`;
    assert.equal((await me(t)).user, null);
  });

  it('expired sessions are ignored', async () => {
    const t = signJwt({ typ: 'session', iss: 'vshare', sub: 'x', email: 'a@college.edu', name: 'a', role: 'faculty', iat: now() - 7200, exp: now() - 10 }, JWT_SECRET);
    assert.equal((await me(t)).user, null);
  });

  it('an OAuth flow token cannot be used as a session', async () => {
    const t = signJwt({ typ: 'oauth-flow', iss: 'vshare', state: 's', nonce: 'n', verifier: 'v', exp: now() + 600 }, JWT_SECRET);
    assert.equal((await me(t)).user, null);
  });

  it('logout clears the cookie', async () => {
    const res = await request(srv.port, { method: 'POST', path: '/auth/logout', headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.match(getCookie(res, 'vs_session').raw, /Max-Age=0/);
  });
});

describe('access control', () => {
  let student;
  let faculty;
  before(async () => {
    student = (await signIn('student@gmail.com')).session.value;
    faculty = (await signIn('dean@college.edu')).session.value;
  });

  it('anonymous uploads get 401 with a login link (even for a large body: no connection reset)', async () => {
    const r = await upload('/api/upload', [['expiry', '1h']], null, crypto.randomBytes(2 * 1024 * 1024));
    assert.equal(r.status, 401);
    assert.match(r.json.login, /^\/auth\/google\?returnTo=/);
    assert.equal((await upload('/api/verify/upload', [['source_url', '']], null)).status, 401);
  });

  it('students can share and verify, but not do faculty actions', async () => {
    const share = await upload('/api/upload', [['expiry', '1h'], ['max_downloads', '1']], student);
    assert.equal(share.status, 201);
    assert.equal((await postJson('/api/context/keys', { campus: 'Main Campus' }, student)).status, 403);
    const study = await upload('/api/study/upload', [['department', 'CSE'], ['year', '1'], ['subject', 'Maths'], ['material_type', 'Notes']], student);
    assert.equal(study.status, 403);
    assert.match(study.json.error, /faculty/i);
  });

  it('faculty can generate campus keys, upload with them and distribute material', async () => {
    const key = await postJson('/api/context/keys', { campus: 'Main Campus' }, faculty);
    assert.equal(key.status, 201);
    const up = await upload('/api/context/upload', [['campus', 'Main Campus'], ['access_key', key.json.key]], faculty);
    assert.equal(up.status, 201);
    const study = await upload('/api/study/upload', [['department', 'CSE'], ['year', '1'], ['subject', 'Maths'], ['material_type', 'Notes']], faculty);
    assert.equal(study.status, 201);
  });

  it('recipients need NO account: share links, campus keys and study lists stay open', async () => {
    const share = await upload('/api/upload', [['expiry', '1h']], student, Buffer.from('for the recipient'));
    const body = '';
    const dl = await request(srv.port, {
      method: 'POST', path: `${share.json.sharePath}/download`, body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 },
    });
    assert.equal(dl.status, 200);
    assert.equal(dl.body.toString(), 'for the recipient');
    assert.equal((await request(srv.port, { path: '/api/study/materials?department=CSE&year=1' })).status, 200);
    const key = await postJson('/api/context/keys', { campus: 'City Campus' }, faculty);
    await upload('/api/context/upload', [['campus', 'City Campus'], ['access_key', key.json.key]], faculty);
    assert.equal((await postJson('/api/context/check', { campus: 'City Campus', key: key.json.key })).status, 200);
  });

  it('browser (HTML) callers get a friendly sign-in page, not JSON', async () => {
    const res = await request(srv.port, {
      method: 'POST', path: '/api/context/keys', body: '{}',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2, Accept: 'text/html' },
    });
    assert.equal(res.status, 401);
  });
});

describe('auth configuration', () => {
  it('without Google credentials sign-in is off and uploads stay open', async () => {
    const plain = await startServer();
    try {
      const m = JSON.parse((await request(plain.port, { path: '/api/me' })).body);
      assert.deepEqual(m, { authEnabled: false, user: null });
      assert.equal((await request(plain.port, { path: '/auth/google' })).status, 404);
    } finally {
      await plain.stop();
    }
  });

  it('the fake-Google test hook cannot be enabled outside NODE_ENV=test + STORAGE=mock', () => {
    const out = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config').AUTH.endpoints))"], {
      cwd: path.resolve(__dirname, '..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'development', STORAGE: 'mock', TEST_GOOGLE_BASE_URL: 'http://127.0.0.1:1' },
    }).toString();
    assert.equal(JSON.parse(out).tokenUrl, 'https://oauth2.googleapis.com/token');
  });
});
