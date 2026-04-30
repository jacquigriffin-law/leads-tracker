// Multi-account inbox aggregator for Vercel serverless.
// Sources:
//   JGMS  — Microsoft 365 via Graph API (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, JGMS_EMAIL)
//   FLA   — IMAP mail.familylawassist.net.au:993 (FLA_EMAIL, FLA_IMAP_PASSWORD)
//   NTRRLS — IMAP mail.ntruralremotelegalservices.com.au:993 (NTRRLS_EMAIL, NTRRLS_IMAP_PASSWORD)
// Returns { configured, inbox_accounts, emails } — each email is reduced to the
// minimum triage/import fields needed by the UI, not full message content.
//
// AUTH: Requires a valid Supabase session access token in the Authorization header.
//   Authorization: Bearer <supabase-access-token>
// Verification prefers SUPABASE_JWT_SECRET when configured, but can also verify
// tokens by calling Supabase Auth directly using the public publishable key.
// INBOX_ALLOWED_EMAILS must be set to a comma-separated list of permitted addresses.
// Missing authorisation config fails closed.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createHmac, timingSafeEqual } = require('crypto');
const { minimiseBody, redactPii, detectInjection } = require('./lib/email-privacy');
const { isSystemEmail } = require('./lib/lead-filter');

const ImapFlowRef = { current: ImapFlow };
const simpleParserRef = { current: simpleParser };

// ── JWT verification (HS256, no external deps) ────────────────────────────────
// Supabase issues HS256 JWTs signed with the project's JWT secret.
function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    // Supabase access tokens for this app must be signed with HS256. Reject
    // unexpected token types/algorithms instead of accepting any valid HMAC.
    if (decodedHeader.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    // Constant-time comparison prevents timing-based signature oracle attacks.
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

  // First try the canonical Auth endpoint.
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      const user = await res.json();
      if (user?.id && user?.email) return { sub: user.id, email: user.email, aud: 'authenticated', verifiedVia: 'auth-user' };
    }
  } catch {
    // Fall through to REST validation below.
  }

  // Fallback for Supabase projects where /auth/v1/user rejects the newer
  // publishable key format from serverless functions. This still validates the
  // bearer token with Supabase: a forged/expired token will be rejected by REST.
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/leads?select=id&limit=1`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
      },
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

// ── In-memory rate limiting ───────────────────────────────────────────────────
// Resets on cold start; Fluid Compute instance reuse gives meaningful protection.
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

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

// ── Structured audit logging (captured by Vercel runtime logs) ────────────────
function audit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...details }));
}

function extractPhone(text) {
  const m = (text || '').match(/(?:(?:\+61\s*4|04)\d{2}[\s\-]?\d{3}[\s\-]?\d{3}|(?:\+61\s*[2378]|0[2378])\d{4}[\s\-]?\d{4})/);
  return m ? m[0].replace(/[\s\-]/g, ' ').trim() : '';
}

// prepareEmailSnippet: minimise the body, detect prompt-injection attempts on
// the minimised text, then redact PII before anything is returned to the UI.
// The raw body never leaves this serverless function.
function prepareEmailSnippet(text, len) {
  const minimised = minimiseBody(text, len);
  const { injection_risk } = detectInjection(minimised);
  const { redacted, redacted_pii } = redactPii(minimised);
  return { snippet: redacted, injection_risk, redacted_pii };
}

function toClientEmail({ id, from_name, from_email, phone, subject, received_at, snippet, source_label, source_account, injection_risk, redacted_pii }) {
  return {
    id,
    from_name,
    from_email,
    phone,
    subject,
    received_at,
    snippet,
    source_label,
    source_account,
    // Privacy flags: injection_risk warns callers not to pass this snippet to an LLM
    // without further review; redacted_pii indicates PII was detected in the snippet.
    injection_risk: injection_risk === true,
    redacted_pii: redacted_pii === true,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getInboxFetchConfig(now = new Date()) {
  const lookbackDays = parsePositiveInt(process.env.INBOX_LOOKBACK_DAYS, 14);
  const maxPerSource = parsePositiveInt(process.env.INBOX_MAX_PER_SOURCE, 120);
  const cutoffDate = new Date(now.getTime() - (lookbackDays * 24 * 60 * 60 * 1000));
  return {
    lookbackDays,
    maxPerSource,
    cutoffDate,
    cutoffIso: cutoffDate.toISOString(),
  };
}

async function getGraphToken(clientId, tenantId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    body,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph auth failed: ${data.error_description || data.error}`);
  return data.access_token;
}

async function fetchJGMS({ clientId, tenantId, clientSecret, email, label, cutoffIso, maxPerSource }) {
  try {
    const token = await getGraphToken(clientId, tenantId, clientSecret);
    const pageSize = Math.min(maxPerSource, 50);
    const baseUrl = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/mailFolders/inbox/messages`);
    baseUrl.searchParams.set('$top', String(pageSize));
    baseUrl.searchParams.set('$orderby', 'receivedDateTime desc');
    baseUrl.searchParams.set('$filter', `receivedDateTime ge ${cutoffIso}`);
    // bodyPreview only — avoids fetching full message bodies across the wire.
    baseUrl.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview');

    const emails = [];
    let nextUrl = baseUrl.toString();
    while (nextUrl && emails.length < maxPerSource) {
      const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return emails;
      const data = await res.json();
      for (const msg of (data.value || [])) {
        if (emails.length >= maxPerSource) break;
        const from = msg.from?.emailAddress || {};
        const bodyText = msg.bodyPreview || '';
        const { snippet, injection_risk, redacted_pii } = prepareEmailSnippet(bodyText, 160);
        if (injection_risk) {
          audit('inbox.injection_risk_detected', { source: label, id: `jgms-${msg.id.slice(-20)}` });
        }
        emails.push(toClientEmail({
          id: `jgms-${msg.id.slice(-20)}`,
          from_name: from.name || from.address || 'Unknown',
          from_email: from.address || '',
          phone: extractPhone(bodyText),
          subject: msg.subject || '(no subject)',
          received_at: msg.receivedDateTime || new Date().toISOString(),
          snippet,
          source_label: label,
          // source_account uses the configured label, not the raw email address,
          // to avoid leaking internal mailbox addresses to the client response.
          source_account: label,
          injection_risk,
          redacted_pii,
        }));
      }
      nextUrl = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : '';
    }

    return emails;
  } catch (err) {
    audit('inbox.fetch_error', { source: label, error: err?.message || 'unknown' });
    return [];
  }
}

async function fetchIMAP({ host, port, user, pass, label, mailboxKey, cutoffDate, maxPerSource }) {
  const client = new ImapFlowRef.current({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    if (typeof client.mailboxOpen === 'function') {
      await client.mailboxOpen('INBOX', { readOnly: true });
    }
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    let emails = [];
    try {
      const matched = await client.search({ since: cutoffDate });
      const selectedUids = [...matched].sort((a, b) => a - b).slice(-maxPerSource);
      if (selectedUids.length > 0) {
        const messages = [];
        for await (const msg of client.fetch(selectedUids, { source: true, uid: true }, { uid: true })) {
          messages.push({ uid: msg.uid, source: msg.source });
        }
        const parsed = await Promise.all(
          messages.reverse().map(async ({ uid, source }) => {
            try {
              const mail = await simpleParserRef.current(source, { skipHtmlToText: false });
              const from = mail.from?.value?.[0] || {};
              const bodyText = mail.text || '';
              const { snippet, injection_risk, redacted_pii } = prepareEmailSnippet(bodyText, 160);
              if (injection_risk) {
                audit('inbox.injection_risk_detected', { source: label, id: `${mailboxKey}-${uid}` });
              }
              return toClientEmail({
                id: `${mailboxKey}-${uid}`,
                from_name: from.name || from.address || 'Unknown',
                from_email: from.address || '',
                phone: extractPhone(bodyText),
                subject: mail.subject || '(no subject)',
                received_at: (mail.date || new Date()).toISOString(),
                snippet,
                source_label: label,
                // source_account uses the configured label, not the raw email address.
                source_account: label,
                injection_risk,
                redacted_pii,
              });
            } catch {
              return null;
            }
          })
        );
        emails = parsed.filter(Boolean);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return emails;
  } catch (err) {
    audit('inbox.fetch_error', { source: label, error: err?.message || 'unknown' });
    try { await client.logout(); } catch {}
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');

  if (req.method && req.method !== 'GET') {
    audit('inbox.method_not_allowed', { method: req.method });
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Client IP — prefer Vercel's forwarded header
  const clientIp = ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  // ── Rate limiting ───────────────────────────────────────────────────────────
  if (isRateLimited(clientIp)) {
    audit('inbox.rate_limited', { ip: clientIp });
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  // ── Authentication ──────────────────────────────────────────────────────────
  // Prefer local JWT verification when SUPABASE_JWT_SECRET is configured. If the
  // project uses Supabase's newer API key screen and the JWT secret is not
  // readily available, fall back to Supabase Auth's /user verification endpoint.
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  const claims = token
    ? (jwtSecret ? verifyJwt(token, jwtSecret) : await verifySupabaseTokenRemote(token))
    : null;
  if (!claims) {
    audit('inbox.auth_failed', { ip: clientIp, jwtMode: jwtSecret ? 'local' : 'remote' });
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const authedUser = claims.email || claims.sub || 'unknown';

  // ── Authorisation ────────────────────────────────────────────────────────────
  // INBOX_ALLOWED_EMAILS (required, comma-separated): explicit allowlist of
  // practice members permitted to read inbox data beyond the JWT check.
  // DEFAULT-DENY: if this var is absent or empty the endpoint returns 503.
  // Set in Vercel env — e.g.:
  //   jacquigriffin@mobilesolicitor.com.au,paralegal@familylawassist.net.au
  const allowedRaw = process.env.INBOX_ALLOWED_EMAILS || '';
  const allowedEmails = allowedRaw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.length === 0) {
    audit('inbox.misconfigured', { ip: clientIp, error: 'INBOX_ALLOWED_EMAILS not configured' });
    return res.status(503).json({ error: 'Inbox temporarily unavailable.' });
  }
  if (!allowedEmails.includes(authedUser.toLowerCase())) {
    audit('inbox.auth_denied', { ip: clientIp, user: authedUser });
    return res.status(403).json({ error: 'Access denied.' });
  }

  audit('inbox.access', { ip: clientIp, user: authedUser });

  // ── Mailbox credentials from Vercel environment ─────────────────────────────
  const inboxFetchConfig = getInboxFetchConfig();
  const jgmsEmail       = process.env.JGMS_EMAIL;
  const azureClientId   = process.env.AZURE_CLIENT_ID;
  const azureTenantId   = process.env.AZURE_TENANT_ID;
  const azureClientSecret = process.env.AZURE_CLIENT_SECRET;
  const flaEmail        = process.env.FLA_EMAIL;
  const flaPass         = process.env.FLA_IMAP_PASSWORD;
  const ntrrlsEmail     = process.env.NTRRLS_EMAIL;
  const ntrrlsPass      = process.env.NTRRLS_IMAP_PASSWORD;

  const jgmsOk    = !!(jgmsEmail && azureClientId && azureTenantId && azureClientSecret);
  const flaOk     = !!(flaEmail && flaPass);
  const ntrrlsOk  = !!(ntrrlsEmail && ntrrlsPass);

  if (!jgmsOk && !flaOk && !ntrrlsOk) {
    audit('inbox.no_mailbox_credentials', { ip: clientIp, user: authedUser });
    return res.status(200).json({ configured: false, emails: [] });
  }

  audit('inbox.fetch_start', { ip: clientIp, user: authedUser, sources: [jgmsOk && 'jgms', flaOk && 'fla', ntrrlsOk && 'ntrrls'].filter(Boolean) });

  const [jgmsResult, flaResult, ntrrlsResult] = await Promise.allSettled([
    jgmsOk
      ? fetchJGMS({ clientId: azureClientId, tenantId: azureTenantId, clientSecret: azureClientSecret, email: jgmsEmail, label: 'JGMS', cutoffIso: inboxFetchConfig.cutoffIso, maxPerSource: inboxFetchConfig.maxPerSource })
      : Promise.resolve([]),
    flaOk
      ? fetchIMAP({ host: 'mail.familylawassist.net.au', port: 993, user: flaEmail, pass: flaPass, label: 'FLA', mailboxKey: 'fla', cutoffDate: inboxFetchConfig.cutoffDate, maxPerSource: inboxFetchConfig.maxPerSource })
      : Promise.resolve([]),
    ntrrlsOk
      ? fetchIMAP({ host: 'mail.ntruralremotelegalservices.com.au', port: 993, user: ntrrlsEmail, pass: ntrrlsPass, label: 'NTRRLS', mailboxKey: 'ntrrls', cutoffDate: inboxFetchConfig.cutoffDate, maxPerSource: inboxFetchConfig.maxPerSource })
      : Promise.resolve([]),
  ]);

  const allEmails = [jgmsResult, flaResult, ntrrlsResult]
    .map((r) => (r.status === 'fulfilled' ? r.value : []))
    .flat()
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

  // Filter out system/operational emails (deployments, auth, platform notices).
  // hidden_count is returned so the UI can note that filtering is active.
  const leadEmails = allEmails.filter((e) => !isSystemEmail(e.from_email, e.from_name, e.subject));
  const hiddenCount = allEmails.length - leadEmails.length;
  if (hiddenCount > 0) {
    audit('inbox.system_filtered', { ip: clientIp, user: authedUser, hidden_count: hiddenCount });
  }

  // Return account labels only, not raw email addresses.
  const accounts = [
    jgmsOk ? 'JGMS' : null,
    flaOk ? 'FLA' : null,
    ntrrlsOk ? 'NTRRLS' : null,
  ].filter(Boolean);

  audit('inbox.fetch_done', { ip: clientIp, user: authedUser, email_count: leadEmails.length, hidden_count: hiddenCount });

  return res.status(200).json({
    configured: true,
    inbox_accounts: accounts,
    inbox_account: accounts[0] || '',
    account: accounts[0] || '',
    last_checked: new Date().toISOString(),
    emails: leadEmails,
    filtered_count: allEmails.length,
    hidden_count: hiddenCount,
  });
};

module.exports._test = {
  fetchJGMS,
  fetchIMAP,
  getInboxFetchConfig,
  ImapFlowRef,
  simpleParserRef,
};
