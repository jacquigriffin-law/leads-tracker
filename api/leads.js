// POST /api/leads — authenticated server-side write path for public.leads
//
// AUTH: Requires valid Supabase JWT in Authorization: Bearer <token>.
//   Verification prefers SUPABASE_JWT_SECRET (local HS256); falls back to
//   Supabase Auth /user endpoint if the secret is absent.
//
// REQUIRED ENV (all three must be set — endpoint returns 503 if any are missing):
//   SUPABASE_SERVICE_ROLE_KEY   — never sent to the browser; bypasses RLS for INSERT
//   LEADS_ALLOWED_EMAILS        — comma-separated allowlist (fallback: INBOX_ALLOWED_EMAILS)
//
// OPTIONAL ENV:
//   SUPABASE_JWT_SECRET         — enables local JWT verification (faster, no outbound call)
//   SUPABASE_URL                — defaults to the project URL
//
// BEHAVIOUR:
//   • Only POST accepted.
//   • Fields are validated against a strict allowlist; unknown keys are silently stripped.
//   • sender_name is the only required field.
//   • id is generated server-side (epoch-ms bigint) — clients must not supply it.
//   • date_received defaults to now if absent or unparseable.
//   • Upserts via Supabase REST with service role key (bypasses RLS; no client exposure).
//   • Returns 201 { ok: true, lead: <inserted row> } on success.
//   • Rate limit: 20 writes per IP per 60 s.

'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

// ── JWT verification (HS256, identical to api/inbox.js) ───────────────────────
function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    // Only HS256 accepted — Supabase access tokens for this project use HS256.
    if (decodedHeader.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const expectedBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(sig);
    if (expectedBuf.length !== sigBuf.length || !timingSafeEqual(expectedBuf, sigBuf)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!claims.sub) return null;
    if (claims.exp && claims.exp < now) return null;
    if (claims.nbf && claims.nbf > now) return null;
    if (claims.aud && claims.aud !== 'authenticated') return null;
    return claims;
  } catch {
    return null;
  }
}

function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function verifySupabaseTokenRemote(token) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://lviislwimdvxuuvmvzfn.supabase.co';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_LAfGPgLAjPLDt3uPmJncfg_Q_Wq3-wW';

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const user = await res.json();
      if (user?.id && user?.email) return { sub: user.id, email: user.email, aud: 'authenticated', verifiedVia: 'auth-user' };
    }
  } catch {
    // Fall through to REST validation.
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/leads?select=id&limit=1`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const claims = decodeJwtPayloadUnsafe(token);
    if (!claims?.sub) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) return null;
    return { sub: claims.sub, email: claims.email || claims.user_metadata?.email || null, aud: claims.aud || 'authenticated', verifiedVia: 'rest' };
  } catch {
    return null;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

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

// ── Audit logging ─────────────────────────────────────────────────────────────
function audit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...details }));
}

// ── Field validation and sanitisation ────────────────────────────────────────
// Only these schema columns are written — all other keys are silently stripped.
const ALLOWED_FIELDS = new Set([
  'source_account', 'date_received', 'sender_name', 'sender_email', 'sender_phone',
  'subject', 'source_rule', 'source_platform', 'matter_type', 'priority', 'status',
  'notes', 'raw_preview', 'location', 'opposing_party', 'next_action',
]);

const VALID_PRIORITIES = new Set(['URGENT', 'HIGH', 'MEDIUM', 'LOW']);
const VALID_STATUSES = new Set(['new', 'follow_up', 'existing_matter', 'closed']);

const MAX_TEXT = 1000;
const MAX_NOTES = 10_000;

function sanitiseString(val, maxLen = MAX_TEXT) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s.slice(0, maxLen) : null;
}

function validateAndSanitise(body) {
  const errors = [];

  const senderName = sanitiseString(body.sender_name, 200);
  if (!senderName) errors.push('sender_name is required');
  if (errors.length) return { errors };

  const record = { sender_name: senderName };

  const shortTextFields = [
    'sender_email', 'sender_phone', 'subject', 'source_account',
    'source_rule', 'source_platform', 'matter_type', 'location',
    'opposing_party', 'next_action',
  ];
  for (const f of shortTextFields) {
    const v = sanitiseString(body[f]);
    if (v !== null) record[f] = v;
  }

  const notes = sanitiseString(body.notes, MAX_NOTES);
  if (notes !== null) record.notes = notes;

  const rawPreview = sanitiseString(body.raw_preview, MAX_NOTES);
  if (rawPreview !== null) record.raw_preview = rawPreview;

  if (body.priority !== undefined) {
    const p = String(body.priority || '').toUpperCase();
    record.priority = VALID_PRIORITIES.has(p) ? p : 'MEDIUM';
  }

  if (body.status !== undefined) {
    const s = String(body.status || '').toLowerCase();
    record.status = VALID_STATUSES.has(s) ? s : 'new';
  }

  if (body.date_received !== undefined) {
    const d = new Date(body.date_received);
    record.date_received = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } else {
    record.date_received = new Date().toISOString();
  }

  return { record };
}

// ── Supabase upsert via service role key (bypasses RLS) ──────────────────────
// Service role key stays server-side only — never returned in any response.
async function upsertLead(record, serviceRoleKey) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://lviislwimdvxuuvmvzfn.supabase.co';
  // Generate a bigint-compatible ID server-side so clients cannot choose arbitrary IDs.
  const id = Date.now();
  const payload = { id, ...record };

  const res = await fetch(`${supabaseUrl}/rest/v1/leads?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      // return=representation echoes back the inserted row (with DB-generated fields).
      // resolution=merge-duplicates triggers upsert on the id conflict target.
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Supabase upsert failed ${res.status}: ${errText.slice(0, 200)}`);
  }

  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');

  if (req.method !== 'POST') {
    audit('leads.method_not_allowed', { method: req.method });
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const clientIp = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  if (isRateLimited(clientIp)) {
    audit('leads.rate_limited', { ip: clientIp });
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  // ── Env gates (fail closed) ───────────────────────────────────────────────
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    audit('leads.misconfigured', { ip: clientIp, error: 'SUPABASE_SERVICE_ROLE_KEY not set' });
    return res.status(503).json({ error: 'Lead write path temporarily unavailable.' });
  }

  const allowedRaw = process.env.LEADS_ALLOWED_EMAILS || process.env.INBOX_ALLOWED_EMAILS || '';
  const allowedEmails = allowedRaw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.length === 0) {
    audit('leads.misconfigured', { ip: clientIp, error: 'LEADS_ALLOWED_EMAILS not configured' });
    return res.status(503).json({ error: 'Lead write path temporarily unavailable.' });
  }

  // ── Authentication ────────────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  const claims = token
    ? (jwtSecret ? verifyJwt(token, jwtSecret) : await verifySupabaseTokenRemote(token))
    : null;
  if (!claims) {
    audit('leads.auth_failed', { ip: clientIp, jwtMode: jwtSecret ? 'local' : 'remote' });
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const authedUser = claims.email || claims.sub || 'unknown';

  // ── Authorisation ─────────────────────────────────────────────────────────
  if (!allowedEmails.includes(authedUser.toLowerCase())) {
    audit('leads.auth_denied', { ip: clientIp, user: authedUser });
    return res.status(403).json({ error: 'Access denied.' });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body = {};
  try {
    if (typeof req.body === 'object' && req.body !== null) {
      body = req.body;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      body = JSON.parse(req.body);
    }
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  // ── Validate fields ───────────────────────────────────────────────────────
  const { record, errors } = validateAndSanitise(body);
  if (errors) {
    return res.status(400).json({ error: errors.join(', ') });
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  audit('leads.write_start', { ip: clientIp, user: authedUser });
  try {
    const inserted = await upsertLead(record, serviceRoleKey);
    audit('leads.write_ok', { ip: clientIp, user: authedUser, id: inserted?.id });
    return res.status(201).json({ ok: true, lead: inserted });
  } catch (err) {
    audit('leads.write_error', { ip: clientIp, user: authedUser, error: err?.message || 'unknown' });
    return res.status(500).json({ error: 'Failed to save lead. Please try again.' });
  }
};

// Exported for unit tests — no I/O, pure logic only.
module.exports._test = { validateAndSanitise, ALLOWED_FIELDS, VALID_PRIORITIES, VALID_STATUSES };
