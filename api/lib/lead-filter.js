'use strict';

// Relevance filter for the live Inbox.
//
// Scoring model:
//   scoreEmail() returns an integer — positive means likely lead, negative means noise.
//   isSystemEmail() wraps scoreEmail() for the existing boolean API (score < 0 → hide).
//
// Priority order inside scoreEmail:
//   1. Protected lead domains → always show (score = +100)
//   2. Blocked operational domains → always hide (score = -100), wins over subject signals
//   3. Blocked automated local-parts → always hide (score = -80)
//   4. Lead subject/sender signals → +20 each
//   5. Noise/admin subject signals  → -20 each
//   Neutral emails (score = 0) are shown — conservative by default.

// ── Allowlist: protected lead sources ──────────────────────────────────────────
// Emails from these domains are always shown regardless of subject content.
const PROTECTED_LEAD_DOMAINS = new Set([
  'legalaid.nsw.gov.au', 'lacmac.com.au', 'justice.nsw.gov.au',
  'nt.gov.au', 'nt.legal.gov.au', 'naaja.com.au', 'ntlac.nt.gov.au',
  'lawconnect.com.au', 'finchly.com.au',
  'forward-sms.app',
  // Northern Territory Legal Aid Commission variants
  'ntlac.nt.gov.au', 'legalaid.nt.gov.au',
]);

// ── Lead signals in subjects ───────────────────────────────────────────────────
// Any of these in the subject indicates a likely real client or referral.
const LEAD_SUBJECT_SIGNALS = [
  'legal aid', 'lawconnect', 'finchly', 'grant of aid',
  'enquiry', 'inquiry', 'referral', 'new client', 'new matter',
  'family law', 'family court', 'federal circuit', 'hearing',
  'consent orders', 'property settlement', 'parenting orders', 'divorce',
  'criminal matter', 'bail', 'sentence', 'court date', 'mention',
  'sms from', 'text from', 'forwarded sms',
  'legal advice', 'legal question', 'legal help', 'legal matter', 'legal issue',
  'need a solicitor', 'need a lawyer', 'seeking representation',
  'domestic violence', 'dvo', 'intervention order', 'avo',
  'child support', 'child custody',
];

// ── Lead signals in sender names ──────────────────────────────────────────────
// Sender name fragments indicating a referral body or known client channel.
const LEAD_SENDER_SIGNALS = [
  'legal aid',
  'lawconnect',
  'finchly',
  'family law assist',
  'nt rural',
  'nt remote',
  'naaja',
];

// ── Denylist: blocked operational domains ─────────────────────────────────────
// Emails from these domains are always hidden, even if the subject contains
// legal-sounding words (e.g. InfoTrack "Family Court - Sync Update").
const BLOCKED_OPERATIONAL_DOMAINS = new Set([
  // CI/CD and platform
  'vercel.com', 'vercel.email',
  'github.com', 'github.io', 'githubusercontent.com',
  'supabase.io', 'supabase.com',
  'atlassian.com', 'jira.com',
  // Legal tech — operational sync/admin only (not client enquiries)
  'infotrack.com.au', 'infotrack.com',
  'leap.com.au',          // LEAP legal software admin notifications
  'actionstep.com',       // Actionstep case management
  'smokeball.com.au', 'smokeball.com',
  'clio.com',
  'lawmaster.com.au',
  // Dev/hosting providers
  'pythonanywhere.com',
  'digitalocean.com', 'digitalocean.email',
  'heroku.com',
  'render.com',
  'railway.app',
  'netlify.com',
  'cloudflare.com', 'cloudflare.email',
  'sentry.io',
  'datadog.com', 'datadoghq.com',
  // Email service infrastructure (automated sends only)
  'sendgrid.net', 'sendgrid.com',
  'amazonses.com',
  'mailgun.org', 'mailgun.net',
  'postmarkapp.com',
  'sparkpostmail.com', 'sparkpost.com',
  // Newsletter/marketing platforms
  'mailchimp.com', 'list-manage.com', 'mailchimpapp.com', 'mcusercontent.com',
  'klaviyo.com', 'klaviyomail.com',
  'campaignmonitor.com', 'cmail20.com', 'cmail1.com', 'cmail2.com', 'createsend.com',
  'constantcontact.com', 'constantcontactpages.com',
  'hubspot.com', 'hs-email.com', 'hubspotemail.net',
  'substack.com',
  'convertkit.com', 'ck-email.com',
  'beehiiv.com',
  'drip.com',
  'activecampaign.com',
  // Payment and billing
  'stripe.com',
  'paypal.com',
  'square.com', 'squareup.com',
  // Accounting
  'xero.com',
  'myob.com',
  'quickbooks.com', 'intuit.com',
  // Collaboration/productivity
  'zoom.us', 'zoom.com',
  'docusign.com',
  'dropbox.com',
  'slack.com',
  'notion.so',
  // Social media
  'linkedin.com',
  'twitter.com', 'x.com',
  'facebook.com', 'meta.com',
  'instagram.com',
  // Known non-lead personal/wellness senders
  'bryanjohnson.com',
]);

// ── Blocked automated local-parts ─────────────────────────────────────────────
// Exact match on the address local-part (before @). Common automated sender names.
const BLOCKED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply',
  'donotreply', 'do-not-reply', 'do_not_reply',
  'notifications', 'notification',
  'alerts', 'alert',
  'automated', 'mailer-daemon', 'postmaster',
  'bounces', 'bounce',
  'billing', 'invoice', 'invoices',
  'newsletter', 'digest',
  'marketing', 'promo', 'promotions',
]);

// ── Noise signals in subjects ─────────────────────────────────────────────────
// Any of these strongly indicates an operational, commercial, or newsletter email.
const NOISE_SUBJECT_SIGNALS = [
  // Platform/CI
  'deployment succeeded', 'deployment failed', 'deployment ready',
  'deployment preview', 'your deployment', 'deployment to production',
  'preview deployment', 'branch deployed', 'deploy preview',
  'vercel: ', '[vercel]',
  'supabase: ', '[supabase]',
  '[github]', 'github notification',
  // Authentication
  'confirm your email', 'verify your email', 'email verification',
  'sign in to supabase', 'sign in to vercel', 'sign in to github',
  'security alert: new sign-in', 'unusual sign-in', 'new device sign-in',
  'action required: verify your',
  // Calendar/meeting
  'calendar invitation', 'calendar invite',
  // Sync/backup (operational)
  'sync update', 'sync complete', 'sync failed',
  'backup complete', 'backup failed',
  'data export ready',
  // Newsletter/subscription management
  'unsubscribe', 'view in browser', 'view this email online',
  'email preferences', 'manage preferences', 'manage subscription',
  'manage your subscription', 'you are subscribed',
  'newsletter', 'weekly digest', 'monthly digest',
  'weekly roundup', 'monthly roundup', 'this week in', 'this month in',
  'edition #', 'issue #',
  // Commercial/transactional
  'your invoice', 'invoice #', 'invoice number',
  'receipt for', 'payment receipt', 'payment confirmation',
  'your order', 'order confirmation', 'order #',
  'promo code', '% off', 'limited time offer', 'sale ends',
  'your subscription', 'subscription renewal', 'subscription expir',
  // Support tickets (platform admin, not client enquiries)
  'ticket #', 'support ticket', 'case #: ',
  '[pythonanywhere]',
  // Wellness/lifestyle — clearly not legal enquiries
  'oral hygiene', 'sleep protocol', 'workout protocol', 'biohacking',
  'supplement stack', 'longevity protocol', 'health protocol',
];

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Scores an email for inbox relevance.
 * @param {string} fromEmail   Sender address (e.g. "hello@bryanjohnson.com")
 * @param {string} fromName    Sender display name (e.g. "InfoTrack Litigation")
 * @param {string} subject     Email subject line
 * @returns {number}  Positive = likely lead/relevant; negative = noise; 0 = uncertain (show)
 */
function scoreEmail(fromEmail, fromName, subject) {
  const addr  = (fromEmail || '').toLowerCase().trim();
  const name  = (fromName  || '').toLowerCase();
  const subj  = (subject   || '').toLowerCase();
  const atIdx = addr.lastIndexOf('@');
  const local  = atIdx !== -1 ? addr.slice(0, atIdx) : '';
  const domain = atIdx !== -1 ? addr.slice(atIdx + 1) : '';

  // 1. Protected lead domains — always show.
  for (const d of PROTECTED_LEAD_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) return 100;
  }

  // 2. Blocked operational domains — always hide (runs before subject checks).
  for (const d of BLOCKED_OPERATIONAL_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) return -100;
  }

  // 3. Blocked automated local-parts — hide.
  if (BLOCKED_LOCAL_PARTS.has(local)) return -80;
  for (const name_ of BLOCKED_LOCAL_PARTS) {
    if (local.startsWith(name_ + '+') || local.startsWith(name_ + '.') ||
        local.startsWith(name_ + '_') || local.startsWith(name_ + '-')) return -80;
  }

  // 4. Score by subject and sender name signals.
  let score = 0;

  for (const sig of LEAD_SUBJECT_SIGNALS) {
    if (subj.includes(sig)) { score += 20; break; }
  }

  for (const sig of LEAD_SENDER_SIGNALS) {
    if (name.includes(sig)) { score += 15; break; }
  }

  for (const sig of NOISE_SUBJECT_SIGNALS) {
    if (subj.includes(sig)) { score -= 20; break; }
  }

  // Neutral (score = 0) is shown — conservative default.
  return score;
}

/**
 * Returns true if the email should be hidden from the Inbox.
 * @param {string} fromEmail
 * @param {string} fromName   Sender display name (optional, pass '' if unavailable)
 * @param {string} subject
 * @returns {boolean}
 */
function isSystemEmail(fromEmail, fromName, subject) {
  return scoreEmail(fromEmail, fromName, subject) < 0;
}

module.exports = { isSystemEmail, scoreEmail };
