'use strict';

const {
  createSessionToken,
  sessionCookie,
  clearSessionCookie,
  verifyPinSession,
  getCookieSessionToken,
  getSessionUser,
  SESSION_TTL_MS,
} = require('./lib/pin-session');

const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;

function sendNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

function isRateLimited(key) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_WINDOW_MS };
  } else {
    entry.count += 1;
  }
  rateLimitStore.set(key, entry);
  return entry.count > RATE_MAX;
}

module.exports = async (req, res) => {
  sendNoStore(res);
  res.setHeader('Vary', 'Cookie');

  if (req.method === 'GET') {
    const token = getCookieSessionToken(req);
    const claims = verifyPinSession(token);
    return res.status(200).json({
      authenticated: Boolean(claims),
      token: claims ? token : null,
      expires_at: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
      user: claims ? { email: claims.email || getSessionUser() } : null,
    });
  }

  if (req.method === 'POST') {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }

    try {
      const token = createSessionToken();
      res.setHeader('Set-Cookie', sessionCookie(token));
      return res.status(200).json({
        authenticated: true,
        token,
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        user: { id: 'leadflow-session', email: getSessionUser() },
      });
    } catch {
      return res.status(503).json({ error: 'LeadFlow session is not configured.' });
    }
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ authenticated: false });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed.' });
};
