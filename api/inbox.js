// Multi-account inbox aggregator for Vercel serverless.
// Sources:
//   JGMS  — Microsoft 365 via Graph API (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, JGMS_EMAIL)
//   FLA   — IMAP mail.familylawassist.net.au:993 (FLA_EMAIL, FLA_IMAP_PASSWORD)
//   NTRRLS — IMAP mail.ntruralremotelegalservices.com.au:993 (NTRRLS_EMAIL, NTRRLS_IMAP_PASSWORD)
// Returns { configured, inbox_accounts, emails } — each email is reduced to the
// minimum triage/import fields needed by the UI, not full message content.
//
// AUTH: Requires a valid Supabase session JWT in the Authorization header.
//   Authorization: Bearer <supabase-access-token>
// SUPABASE_JWT_SECRET must be set in Vercel env (Supabase Dashboard → Settings → API → JWT Secret).
// INBOX_ALLOWED_EMAILS must be set to a comma-separated list of permitted addresses.
// Both vars are required — the endpoint returns 503 if either is absent (default-deny).

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createHmac, timingSafeEqual } = require('crypto');

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

// ── In-memory rate limiting ───────────────────────────────────────────────────
// Resets on cold start; Fluid Compute instance reuse gives meaningful protection.
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 4;

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

function toSnippet(text, len) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

function toClientEmail({ id, from_name, from_email, phone, subject, received_at, snippet, source_label, source_account }) {
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

async function fetchJGMS({ clientId, tenantId, clientSecret, email, label }) {
  try {
    const token = await getGraphToken(clientId, tenantId, clientSecret);
    const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/mailFolders/inbox/messages`);
    url.searchParams.set('$top', '15');
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    // bodyPreview only — avoids fetching full message bodies across the wire.
    url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.value || []).map((msg) => {
      const from = msg.from?.emailAddress || {};
      const bodyText = msg.bodyPreview || '';
      return toClientEmail({
        id: `jgms-${msg.id.slice(-20)}`,
        from_name: from.name || from.address || 'Unknown',
        from_email: from.address || '',
        phone: extractPhone(bodyText),
        subject: msg.subject || '(no subject)',
        received_at: msg.receivedDateTime || new Date().toISOString(),
        snippet: toSnippet(bodyText, 160),
        source_label: label,
        // source_account uses the configured label, not the raw email address,
        // to avoid leaking internal mailbox addresses to the client response.
        source_account: label,
      });
    });
  } catch (err) {
    audit('inbox.fetch_error', { source: label, error: err?.message || 'unknown' });
    return [];
  }
}

async function fetchIMAP({ host, port, user, pass, label, mailboxKey }) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let emails = [];
    try {
      const total = client.mailbox.exists;
      if (total > 0) {
        const start = Math.max(1, total - 14);
        const messages = [];
        for await (const msg of client.fetch(`${start}:${total}`, { source: true, uid: true })) {
          messages.push({ uid: msg.uid, source: msg.source });
        }
        const parsed = await Promise.all(
          messages.reverse().map(async ({ uid, source }) => {
            try {
              const mail = await simpleParser(source, { skipHtmlToText: false });
              const from = mail.from?.value?.[0] || {};
              const bodyText = mail.text || '';
              return toClientEmail({
                id: `${mailboxKey}-${uid}`,
                from_name: from.name || from.address || 'Unknown',
                from_email: from.address || '',
                phone: extractPhone(bodyText),
                subject: mail.subject || '(no subject)',
                received_at: (mail.date || new Date()).toISOString(),
                snippet: toSnippet(bodyText, 160),
                source_label: label,
                // source_account uses the configured label, not the raw email address.
                source_account: label,
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
  // SUPABASE_JWT_SECRET must be set in Vercel env:
  //   Supabase Dashboard → Settings → API → JWT Settings → JWT Secret
  // Missing secret returns 503 (misconfiguration), not a silent open door.
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    audit('inbox.misconfigured', { ip: clientIp, error: 'SUPABASE_JWT_SECRET not set' });
    return res.status(503).json({ error: 'Inbox temporarily unavailable.' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const claims = token ? verifyJwt(token, jwtSecret) : null;
  if (!claims) {
    audit('inbox.auth_failed', { ip: clientIp });
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
      ? fetchJGMS({ clientId: azureClientId, tenantId: azureTenantId, clientSecret: azureClientSecret, email: jgmsEmail, label: 'JGMS' })
      : Promise.resolve([]),
    flaOk
      ? fetchIMAP({ host: 'mail.familylawassist.net.au', port: 993, user: flaEmail, pass: flaPass, label: 'FLA', mailboxKey: 'fla' })
      : Promise.resolve([]),
    ntrrlsOk
      ? fetchIMAP({ host: 'mail.ntruralremotelegalservices.com.au', port: 993, user: ntrrlsEmail, pass: ntrrlsPass, label: 'NTRRLS', mailboxKey: 'ntrrls' })
      : Promise.resolve([]),
  ]);

  const allEmails = [jgmsResult, flaResult, ntrrlsResult]
    .map((r) => (r.status === 'fulfilled' ? r.value : []))
    .flat()
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

  // Return account labels only, not raw email addresses.
  const accounts = [
    jgmsOk ? 'JGMS' : null,
    flaOk ? 'FLA' : null,
    ntrrlsOk ? 'NTRRLS' : null,
  ].filter(Boolean);

  audit('inbox.fetch_done', { ip: clientIp, user: authedUser, email_count: allEmails.length });

  return res.status(200).json({
    configured: true,
    inbox_accounts: accounts,
    inbox_account: accounts[0] || '',
    account: accounts[0] || '',
    last_checked: new Date().toISOString(),
    emails: allEmails,
  });
};
