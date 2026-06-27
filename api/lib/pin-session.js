'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const COOKIE_NAME = 'leadflow_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const DEFAULT_USER_EMAIL = 'jacquigriffin@mobilesolicitor.com.au';

function getSessionSecret() {
  return process.env.LEADFLOW_SESSION_SECRET || '';
}

function getConfiguredPin() {
  return process.env.LEADFLOW_PIN || '';
}

function getSessionUser() {
  return process.env.LEADFLOW_SESSION_EMAIL || DEFAULT_USER_EMAIL;
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

function verifyPin(pin) {
  const configured = getConfiguredPin();
  return Boolean(configured && safeEqual(String(pin || '').trim(), configured));
}

function signPayload(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken() {
  const secret = getSessionSecret();
  if (!secret) throw new Error('LEADFLOW_SESSION_SECRET not configured');
  const now = Date.now();
  const claims = {
    sub: 'leadflow-pin',
    email: getSessionUser(),
    scope: 'leadflow',
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + SESSION_TTL_MS) / 1000),
    nonce: randomBytes(12).toString('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

function verifyToken(token) {
  const secret = getSessionSecret();
  if (!secret || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = signPayload(payload, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (claims.scope !== 'leadflow') return null;
    if (!claims.sub || !claims.email) return null;
    if (claims.exp && claims.exp < now) return null;
    return claims;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf('=');
      if (index < 0) return acc;
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function getRequestToken(req) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies[COOKIE_NAME] || '';
}

function getCookieSessionToken(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies[COOKIE_NAME] || '';
}

function verifyPinSession(reqOrToken) {
  const token = typeof reqOrToken === 'string' ? reqOrToken : getRequestToken(reqOrToken);
  return verifyToken(token);
}

function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions(SESSION_TTL_SECONDS)}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; ${cookieOptions(0)}`;
}

module.exports = {
  SESSION_TTL_MS,
  createPinSession: createSessionToken,
  createSessionToken,
  verifyPin,
  verifyPinSession,
  verifyLeadflowSession: verifyPinSession,
  getCookieSessionToken,
  getSessionUser,
  sessionCookie,
  clearSessionCookie,
};
