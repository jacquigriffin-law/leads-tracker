// Multi-account inbox aggregator for Vercel serverless.
// Sources:
//   JGMS  — Microsoft 365 via Graph API (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET, JGMS_EMAIL)
//   FLA   — IMAP mail.familylawassist.net.au:993 (FLA_EMAIL, FLA_IMAP_PASSWORD)
//   NTRRLS — IMAP mail.ntruralremotelegalservices.com.au:993 (NTRRLS_EMAIL, NTRRLS_IMAP_PASSWORD)
// Returns { configured, inbox_accounts, emails } — each email includes mailbox + source_account.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function extractPhone(text) {
  const m = (text || '').match(/(?:(?:\+61\s*4|04)\d{2}[\s\-]?\d{3}[\s\-]?\d{3}|(?:\+61\s*[2378]|0[2378])\d{4}[\s\-]?\d{4})/);
  return m ? m[0].replace(/[\s\-]/g, ' ').trim() : '';
}

function toSnippet(text, len) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, len);
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

async function fetchJGMS({ clientId, tenantId, clientSecret, email }) {
  try {
    const token = await getGraphToken(clientId, tenantId, clientSecret);
    const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/mailFolders/inbox/messages`);
    url.searchParams.set('$top', '15');
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,body');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.value || []).map((msg) => {
      const from = msg.from?.emailAddress || {};
      const rawBody = msg.body?.content || msg.bodyPreview || '';
      const bodyText = msg.body?.contentType === 'html'
        ? rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : rawBody;
      return {
        id: `jgms-${msg.id.slice(-20)}`,
        from_name: from.name || from.address || 'Unknown',
        from_email: from.address || '',
        phone: extractPhone(bodyText),
        subject: msg.subject || '(no subject)',
        received_at: msg.receivedDateTime || new Date().toISOString(),
        snippet: toSnippet(bodyText, 200),
        body_preview: toSnippet(bodyText, 600),
        matter_type: '',
        priority: 'MEDIUM',
        location: '',
        opposing_party: '',
        next_action: '',
        source_label: 'JGMS',
        mailbox: 'jgms',
        source_account: email,
      };
    });
  } catch {
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
              return {
                id: `${mailboxKey}-${uid}`,
                from_name: from.name || from.address || 'Unknown',
                from_email: from.address || '',
                phone: extractPhone(bodyText),
                subject: mail.subject || '(no subject)',
                received_at: (mail.date || new Date()).toISOString(),
                snippet: toSnippet(bodyText, 200),
                body_preview: toSnippet(bodyText, 600),
                matter_type: '',
                priority: 'MEDIUM',
                location: '',
                opposing_party: '',
                next_action: '',
                source_label: label,
                mailbox: mailboxKey,
                source_account: user,
              };
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
  } catch {
    try { await client.logout(); } catch {}
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

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
    return res.status(200).json({ configured: false, emails: [] });
  }

  const [jgmsResult, flaResult, ntrrlsResult] = await Promise.allSettled([
    jgmsOk
      ? fetchJGMS({ clientId: azureClientId, tenantId: azureTenantId, clientSecret: azureClientSecret, email: jgmsEmail })
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

  const accounts = [
    jgmsOk ? jgmsEmail : null,
    flaOk ? flaEmail : null,
    ntrrlsOk ? ntrrlsEmail : null,
  ].filter(Boolean);

  return res.status(200).json({
    configured: true,
    inbox_accounts: accounts,
    inbox_account: accounts[0] || '',
    account: accounts[0] || '',
    last_checked: new Date().toISOString(),
    emails: allEmails,
  });
};
