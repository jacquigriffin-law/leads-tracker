// POST /api/ai-triage  — gated OpenAI extraction for inbox email triage
// GET  /api/ai-triage  — capability probe: { available: boolean } (no auth required)
//
// REQUIRED ENV GATES (all three must be set correctly before any LLM call):
//   LLM_PROVIDER=openai
//   LLM_POLICY_CONFIRMED=true
//   OPENAI_API_KEY=<key>
//   OPENAI_MODEL (optional — default: gpt-4o-mini, a current low-cost OpenAI model)
//
// AUTH (POST only): Requires valid Supabase JWT + INBOX_ALLOWED_EMAILS membership.
//
// POST REQUEST BODY:
//   { email_id: string, subject: string, snippet: string, source_label: string }
//   snippet must be the already-minimised snippet from /api/inbox (≤160 chars).
//   Full email bodies and attachments must never be sent.
//
// PIPELINE:
//   buildLlmInput(snippet, subject)
//     → injection check (abort + log if detected)
//     → OpenAI Chat Completions (store: false, json_object mode)
//     → validateLlmOutput (enforce schema, requires_human_review=true)
//     → log_llm_processing RPC (best-effort, metadata only — no PII)
//
// ERROR BEHAVIOUR:
//   503 — env gates not met (message: non-secret description only)
//   401 — JWT missing or invalid
//   403 — user not in INBOX_ALLOWED_EMAILS
//   429 — rate limited (5 LLM calls per minute per IP)
//   422 — injection risk detected in input
//   400 — bad request body
//   502 — OpenAI returned an error or invalid output

'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const { buildLlmInput, validateLlmOutput } = require('./lib/email-privacy');

// ── Env gate check ────────────────────────────────────────────────────────────
// All three vars must be present and correct. Exported for unit tests.
function checkEnvGates() {
  if (process.env.LLM_PROVIDER !== 'openai') {
    return { ok: false, reason: 'LLM_PROVIDER not configured for openai' };
  }
  if (process.env.LLM_POLICY_CONFIRMED !== 'true') {
    return { ok: false, reason: 'LLM_POLICY_CONFIRMED not set to true' };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, reason: 'OPENAI_API_KEY not configured' };
  }
  return { ok: true };
}

// ── JWT verification (HS256, same approach as api/inbox.js) ──────────────────
function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
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

async function verifySupabaseTokenRemote(token) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://lviislwimdvxuuvmvzfn.supabase.co';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_LAfGPgLAjPLDt3uPmJncfg_Q_Wq3-wW';
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id || !user?.email) return null;
    return { sub: user.id, email: user.email, aud: 'authenticated' };
  } catch {
    return null;
  }
}

// ── Rate limiting (tighter than inbox — each LLM call has an API cost) ───────
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_LLM = 5;

function isRateLimited(key) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_WINDOW_MS };
  } else {
    entry.count += 1;
  }
  rateLimitStore.set(key, entry);
  return entry.count > RATE_MAX_LLM;
}

// ── Structured audit logging ──────────────────────────────────────────────────
function audit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...details }));
}

// ── Supabase LLM audit log (best-effort, uses the user's JWT) ────────────────
// The log_llm_processing() function is security-definer and enforces
// requires_human_review=true at the DB layer regardless of caller input.
// This call is fire-and-forget — failure does not block the extraction response.
async function logLlmProcessing(token, params) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://lviislwimdvxuuvmvzfn.supabase.co';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_LAfGPgLAjPLDt3uPmJncfg_Q_Wq3-wW';
  try {
    await fetch(`${supabaseUrl}/rest/v1/rpc/log_llm_processing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
    });
  } catch {
    // Non-fatal — audit logging failure never blocks the extraction
  }
}

// ── OpenAI Chat Completions call ──────────────────────────────────────────────
// Uses store: false to prevent OpenAI from retaining this request for training.
// Temperature 0 and json_object response_format for deterministic structured output.
const SYSTEM_PROMPT =
  'You are a legal triage assistant. Return ONLY a JSON object — no other text.\n' +
  'Extract these fields from the email snippet:\n' +
  '  matter_type_guess: one of exactly: family_law | property | criminal | estate | employment | immigration | other | unclear\n' +
  '  urgency_guess: one of exactly: urgent | standard | unclear\n' +
  '  requires_human_review: always true\n' +
  '  human_review_warning: "AI triage hint only. Practitioner review required before any action."\n' +
  '  location_mentioned: Australian state or territory only (e.g. "NSW", "VIC"), or null\n' +
  'No other fields. No PII. No verbatim email content.';

async function callOpenAi({ subject, snippet, source_label, model, apiKey }) {
  const userMessage = `Subject: ${subject}\nSnippet: ${snippet}\nSource: ${source_label}`;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 200,
      store: false,
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI ${response.status}: ${errBody.slice(0, 100)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty OpenAI response');
  return {
    content,
    prompt_tokens: data.usage?.prompt_tokens || null,
    completion_tokens: data.usage?.completion_tokens || null,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');

  // ── GET probe: returns { available: boolean } without auth requirement ───
  if (!req.method || req.method === 'GET') {
    const gate = checkEnvGates();
    return res.status(200).json({ available: gate.ok });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    audit('ai_triage.method_not_allowed', { method: req.method });
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  // ── Env gates ────────────────────────────────────────────────────────────
  const gate = checkEnvGates();
  if (!gate.ok) {
    audit('ai_triage.gates_not_met', { reason: gate.reason });
    return res.status(503).json({ ok: false, error: 'AI triage is not configured on this deployment.' });
  }

  const clientIp = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  // ── Rate limiting ────────────────────────────────────────────────────────
  if (isRateLimited(clientIp)) {
    audit('ai_triage.rate_limited', { ip: clientIp });
    return res.status(429).json({ ok: false, error: 'Too many AI requests. Try again in a minute.' });
  }

  // ── Authentication ───────────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  const claims = token
    ? (jwtSecret ? verifyJwt(token, jwtSecret) : await verifySupabaseTokenRemote(token))
    : null;
  if (!claims) {
    audit('ai_triage.auth_failed', { ip: clientIp, jwtMode: jwtSecret ? 'local' : 'remote' });
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }

  const authedUser = claims.email || claims.sub || 'unknown';

  // ── Authorisation ────────────────────────────────────────────────────────
  const allowedRaw = process.env.INBOX_ALLOWED_EMAILS || '';
  const allowedEmails = allowedRaw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.length === 0) {
    audit('ai_triage.misconfigured', { ip: clientIp, error: 'INBOX_ALLOWED_EMAILS not configured' });
    return res.status(503).json({ ok: false, error: 'AI triage temporarily unavailable.' });
  }
  if (!allowedEmails.includes(authedUser.toLowerCase())) {
    audit('ai_triage.auth_denied', { ip: clientIp, user: authedUser });
    return res.status(403).json({ ok: false, error: 'Access denied.' });
  }

  // ── Request body validation ──────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
  }

  const { email_id, subject, snippet, source_label } = body || {};

  if (!email_id || typeof email_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'email_id is required.' });
  }
  if (typeof snippet !== 'string' || snippet.length === 0) {
    return res.status(400).json({ ok: false, error: 'snippet is required.' });
  }
  // Hard guard: reject anything approaching a full email body.
  // The /api/inbox endpoint caps snippets at 160 chars; allow modest margin.
  if (snippet.length > 320) {
    audit('ai_triage.snippet_too_long', { ip: clientIp, user: authedUser, len: snippet.length });
    return res.status(400).json({ ok: false, error: 'snippet exceeds maximum allowed length.' });
  }

  // ── Privacy pipeline ─────────────────────────────────────────────────────
  // Defence-in-depth: run the full pipeline even though /api/inbox already
  // minimised and redacted the snippet. Catches any client-side tampering.
  const privacyResult = buildLlmInput({
    snippet,
    subject: subject || '',
    source_label: source_label || '',
  });

  if (!privacyResult.safe) {
    audit('ai_triage.injection_blocked', {
      ip: clientIp,
      user: authedUser,
      email_id: String(email_id).slice(-20),
      pattern_count: privacyResult.matched_patterns?.length || 0,
    });
    void logLlmProcessing(token, {
      p_lead_id: email_id,
      p_source_label: source_label || null,
      p_model_id: 'blocked',
      p_injection_risk_detected: true,
      p_pii_redacted: false,
      p_output_summary: 'Blocked: injection risk detected before LLM call',
    });
    return res.status(422).json({ ok: false, error: 'Email contains patterns that prevent AI processing.' });
  }

  // ── OpenAI call ──────────────────────────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const { llm_input, redacted_pii } = privacyResult;

  audit('ai_triage.request', {
    ip: clientIp,
    user: authedUser,
    email_id: String(email_id).slice(-20),
    model: openaiModel,
    redacted_pii: Boolean(redacted_pii),
  });

  let openaiResult;
  try {
    openaiResult = await callOpenAi({
      subject: llm_input.subject,
      snippet: llm_input.snippet,
      source_label: llm_input.source_label,
      model: openaiModel,
      apiKey: openaiKey,
    });
  } catch (err) {
    audit('ai_triage.openai_error', {
      ip: clientIp,
      user: authedUser,
      error: (err?.message || '').slice(0, 80),
    });
    return res.status(502).json({ ok: false, error: 'AI extraction failed. Try again later.' });
  }

  // ── Output validation ────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = JSON.parse(openaiResult.content);
  } catch {
    audit('ai_triage.invalid_json_response', { ip: clientIp, user: authedUser });
    return res.status(502).json({ ok: false, error: 'AI extraction returned unexpected output.' });
  }

  // Enforce requires_human_review and warning regardless of LLM output.
  // The DB insert function also enforces this at the database layer.
  parsed.requires_human_review = true;
  if (!parsed.human_review_warning || typeof parsed.human_review_warning !== 'string') {
    parsed.human_review_warning = 'AI triage hint only. Practitioner review required before any action.';
  }

  const { valid, errors } = validateLlmOutput(parsed);
  if (!valid) {
    audit('ai_triage.schema_invalid', { ip: clientIp, user: authedUser, errors: errors.slice(0, 3) });
    return res.status(502).json({ ok: false, error: 'AI extraction returned unexpected output.' });
  }

  // ── Supabase audit log (best-effort, metadata only — no PII) ────────────
  const outputSummary =
    `matter_type:${parsed.matter_type_guess}, urgency:${parsed.urgency_guess}` +
    (parsed.location_mentioned ? `, location:${parsed.location_mentioned}` : '');

  void logLlmProcessing(token, {
    p_lead_id: email_id,
    p_source_label: source_label || null,
    p_model_id: openaiModel,
    p_prompt_tokens: openaiResult.prompt_tokens,
    p_completion_tokens: openaiResult.completion_tokens,
    p_injection_risk_detected: false,
    p_pii_redacted: Boolean(redacted_pii),
    p_extraction_schema_version: '1.0',
    p_output_summary: outputSummary,
  });

  audit('ai_triage.complete', {
    ip: clientIp,
    user: authedUser,
    email_id: String(email_id).slice(-20),
    model: openaiModel,
    matter_type: parsed.matter_type_guess,
    urgency: parsed.urgency_guess,
  });

  return res.status(200).json({ ok: true, extraction: parsed });
};

// Export checkEnvGates for unit tests
module.exports.checkEnvGates = checkEnvGates;
