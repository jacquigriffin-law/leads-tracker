// Vercel serverless function — reads Gmail IMAP and returns emails in inbox format.
// Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD
// Returns { configured: false } when env vars are absent so the frontend shows an empty inbox.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function extractPhone(text) {
  // Matches AU mobile (04xx) and landline (0[2378]xx) numbers
  const m = (text || '').match(/(?:(?:\+61\s*4|04)\d{2}[\s\-]?\d{3}[\s\-]?\d{3}|(?:\+61\s*[2378]|0[2378])\d{4}[\s\-]?\d{4})/);
  return m ? m[0].replace(/[\s\-]/g, ' ').trim() : '';
}

function toSnippet(text, len) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    return res.status(200).json({ configured: false, emails: [] });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
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
        const start = Math.max(1, total - 14); // fetch last 15 messages
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
                id: `gmail-${uid}`,
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
                source_label: 'Direct Email',
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

    return res.status(200).json({
      configured: true,
      inbox_account: user,
      account: user,
      last_checked: new Date().toISOString(),
      emails,
    });
  } catch (err) {
    try { await client.logout(); } catch {}
    return res.status(500).json({
      configured: true,
      error: `IMAP error: ${err.message}`,
      emails: [],
    });
  }
};
