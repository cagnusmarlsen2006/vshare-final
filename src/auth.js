'use strict';

/**
 * Google sign-in (OAuth 2.0 authorization-code flow + OpenID Connect) and
 * JWT session cookies. No external auth libraries: Node's crypto does it all.
 *
 *   GET  /auth/google            -> redirect to Google (state + nonce + PKCE S256)
 *   GET  /auth/google/callback   -> exchange code, VERIFY the ID token (RS256 via
 *                                   Google's JWKS, iss, aud, exp, nonce, email_verified),
 *                                   issue our own HS256 JWT in an HttpOnly cookie
 *   POST /auth/logout            -> clear the cookie
 *   GET  /api/me                 -> { authEnabled, user }
 *
 * Roles: "faculty" if the email (or its @domain) is in FACULTY_EMAILS, else "student".
 * When Google credentials are not configured, auth is disabled and every
 * requireUser/requireFaculty check passes (the app works as before).
 */
const crypto = require('crypto');
const express = require('express');
const log = require('./logger');
const views = require('./views');
const { wantsJson } = require('./http');

const SESSION_COOKIE = 'vs_session';
const FLOW_COOKIE = 'vs_oauth';
const FLOW_TTL_SECONDS = 10 * 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

/* ------------------------------------------------------------------ */
/* base64url + HS256 JWT                                               */
/* ------------------------------------------------------------------ */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

/** Verify an HS256 JWT; returns the payload or null. Rejects alg "none" and anything else. */
function verifyJwt(token, secret, { issuer } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = fromB64url(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (issuer && payload.iss !== issuer) return null;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function cookie(name, value, { maxAge, secure, path = '/' }) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Only same-site relative paths ("/x"), never "//evil.com" or "/\\evil.com". */
function safeReturnTo(value) {
  const v = String(value || '/');
  return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(v) && v.length < 300 ? v : '/';
}

/* ------------------------------------------------------------------ */
/* Google ID-token verification (RS256 + JWKS)                         */
/* ------------------------------------------------------------------ */
async function fetchJson(url, options = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, { ...options, signal: ac.signal });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function createJwks(url) {
  let keys = null;
  let fetchedAt = 0;
  async function load(force) {
    if (!force && keys && Date.now() - fetchedAt < JWKS_TTL_MS) return keys;
    const { status, body } = await fetchJson(url);
    if (status !== 200 || !Array.isArray(body.keys)) throw new Error(`JWKS fetch failed (HTTP ${status})`);
    keys = new Map(body.keys.filter((k) => k.kty === 'RSA' && k.kid).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    fetchedAt = Date.now();
    return keys;
  }
  return {
    async key(kid) {
      let ks = await load(false);
      if (!ks.has(kid)) ks = await load(true); // Google rotates keys
      return ks.get(kid) || null;
    },
  };
}

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function verifyGoogleIdToken(idToken, { jwks, clientId, issuers, nonce }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new AuthError(401, 'Malformed ID token.');
  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    throw new AuthError(401, 'Malformed ID token.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError(401, 'Unexpected ID token algorithm.');
  const key = await jwks.key(header.kid);
  if (!key) throw new AuthError(401, 'Unknown ID token signing key.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
  if (!ok) throw new AuthError(401, 'Invalid ID token signature.');
  const now = Math.floor(Date.now() / 1000);
  if (!issuers.includes(payload.iss)) throw new AuthError(401, 'Wrong ID token issuer.');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new AuthError(401, 'ID token was not issued for this app.');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) throw new AuthError(401, 'ID token expired.');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > now) throw new AuthError(401, 'ID token issued in the future.');
  const a = Buffer.from(String(payload.nonce || ''));
  const b = Buffer.from(String(nonce || ''));
  if (!nonce || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AuthError(401, 'ID token nonce mismatch.');
  if (!payload.email || payload.email_verified !== true) throw new AuthError(403, 'Your Google email address is not verified.');
  return payload;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */
function roleFor(email, facultyEmails) {
  const e = String(email).toLowerCase();
  const domain = e.slice(e.lastIndexOf('@'));
  return facultyEmails.some((f) => f === e || (f.startsWith('@') && f === domain)) ? 'faculty' : 'student';
}

function createAuth({ config, masterKey, limiters, replyAfterDrain }) {
  const A = config.AUTH;
  const secret = A.jwtSecret
    ? Buffer.from(A.jwtSecret)
    : Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('vshare-jwt-salt'), Buffer.from('vshare session jwt v1'), 32));
  const ISSUER = 'vshare';
  const jwks = A.enabled ? createJwks(A.endpoints.jwksUrl) : null;

  /** Attach req.user from the session cookie (never throws). */
  function middleware(req, res, next) {
    req.user = null;
    if (A.enabled) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const p = token ? verifyJwt(token, secret, { issuer: ISSUER }) : null;
      if (p && p.typ === 'session') req.user = { sub: p.sub, email: p.email, name: p.name, role: p.role };
    }
    next();
  }

  function deny(req, res, status, message) {
    let back = '/';
    try {
      if (req.get('referer')) back = new URL(req.get('referer'), A.publicUrl).pathname;
    } catch {
      back = '/';
    }
    const loginUrl = `/auth/google?returnTo=${encodeURIComponent(safeReturnTo(back))}`;
    const send = () => {
      if (res.headersSent) return;
      res.set('Connection', 'close');
      if (wantsJson(req)) res.status(status).json({ error: message, login: loginUrl });
      else res.status(status).type('html').send(views.errorPage({ status, title: status === 401 ? 'Please sign in' : 'Not allowed', message }));
    };
    // Uploads: read (bounded) the request body first so the client sees the reply, not a reset.
    if (req.headers['content-length'] !== '0' && (req.headers['content-length'] || req.headers['transfer-encoding'])) {
      replyAfterDrain(req, send);
    } else send();
  }

  function requireUser(req, res, next) {
    if (!A.enabled || req.user) return next();
    return deny(req, res, 401, 'Please sign in with Google to upload files.');
  }

  function requireFaculty(req, res, next) {
    if (!A.enabled) return next();
    if (!req.user) return deny(req, res, 401, 'Please sign in with Google (faculty account) to do this.');
    if (req.user.role !== 'faculty') return deny(req, res, 403, 'Only faculty accounts can do this. Ask the administrator to add your email to FACULTY_EMAILS.');
    return next();
  }

  /* ---------------- routes ---------------- */
  const router = express.Router();

  router.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ authEnabled: A.enabled, user: req.user || null });
  });

  router.get('/auth/google', limiters.access, (req, res) => {
    if (!A.enabled) {
      res.status(404).type('html').send(views.errorPage({ status: 404, title: 'Sign-in is not configured', message: 'Google sign-in has not been set up on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' }));
      return;
    }
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const flow = signJwt({
      typ: 'oauth-flow', iss: ISSUER, state, nonce, verifier,
      returnTo: safeReturnTo(req.query.returnTo), exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
    }, secret);
    res.set('Set-Cookie', cookie(FLOW_COOKIE, flow, { maxAge: FLOW_TTL_SECONDS, secure: A.secureCookies, path: '/auth' }));
    const url = new URL(A.endpoints.authUrl);
    url.search = new URLSearchParams({
      client_id: A.clientId,
      redirect_uri: A.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    res.set('Cache-Control', 'no-store').redirect(302, url.toString());
  });

  router.get('/auth/google/callback', limiters.access, async (req, res) => {
    const fail = (status, message) => {
      res.set('Set-Cookie', cookie(FLOW_COOKIE, '', { maxAge: 0, secure: A.secureCookies, path: '/auth' }));
      res.status(status).type('html').send(views.errorPage({ status, title: 'Sign-in failed', message }));
    };
    if (!A.enabled) return fail(404, 'Google sign-in is not configured on this server.');
    if (req.query.error) return fail(401, 'Google sign-in was cancelled or denied.');
    const flow = verifyJwt(parseCookies(req.headers.cookie)[FLOW_COOKIE], secret, { issuer: ISSUER });
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    if (!flow || flow.typ !== 'oauth-flow' || !code) return fail(400, 'This sign-in link is invalid or expired. Please try again.');
    const sa = Buffer.from(state);
    const sb = Buffer.from(flow.state);
    if (sa.length !== sb.length || !crypto.timingSafeEqual(sa, sb)) return fail(400, 'Sign-in state mismatch (possible CSRF). Please try again.');

    try {
      const { status, body } = await fetchJson(A.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: A.clientId,
          client_secret: A.clientSecret,
          redirect_uri: A.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
        }).toString(),
      });
      if (status !== 200 || !body.id_token) throw new AuthError(502, 'Google did not accept the sign-in code. Please try again.');
      const claims = await verifyGoogleIdToken(body.id_token, {
        jwks, clientId: A.clientId, issuers: A.endpoints.issuers, nonce: flow.nonce,
      });
      const email = String(claims.email).toLowerCase();
      const domain = email.slice(email.lastIndexOf('@') + 1);
      if (A.allowedDomains.length && !A.allowedDomains.includes(domain)) {
        throw new AuthError(403, `Only ${A.allowedDomains.map((d) => `@${d}`).join(', ')} accounts can sign in here.`);
      }
      const now = Math.floor(Date.now() / 1000);
      const session = signJwt({
        typ: 'session',
        iss: ISSUER,
        sub: String(claims.sub),
        email,
        name: String(claims.name || email).slice(0, 80),
        role: roleFor(email, A.facultyEmails),
        iat: now,
        exp: now + A.sessionTtlSeconds,
      }, secret);
      res.set('Set-Cookie', [
        cookie(FLOW_COOKIE, '', { maxAge: 0, secure: A.secureCookies, path: '/auth' }),
        cookie(SESSION_COOKIE, session, { maxAge: A.sessionTtlSeconds, secure: A.secureCookies }),
      ]);
      log.info('user signed in');
      res.set('Cache-Control', 'no-store').redirect(302, flow.returnTo || '/');
    } catch (err) {
      if (err instanceof AuthError) return fail(err.status, err.message);
      log.warn(`sign-in failed: ${err.message}`);
      return fail(502, 'Could not reach Google to complete sign-in. Please try again.');
    }
    return undefined;
  });

  router.post('/auth/logout', (req, res) => {
    res.set('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: A.secureCookies }));
    if (wantsJson(req)) res.json({ ok: true });
    else res.redirect(303, '/');
  });

  return { middleware, requireUser, requireFaculty, router, secret };
}

module.exports = { createAuth, signJwt, verifyJwt, parseCookies, safeReturnTo, roleFor, verifyGoogleIdToken };
