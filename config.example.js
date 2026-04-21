window.LEADS_CONFIG = {
  supabase: {
    enabled: false,
    url: 'https://YOUR_PROJECT.supabase.co',
    anonKey: 'YOUR_SUPABASE_ANON_KEY'
  }
};

// === Inbox env vars (set in Vercel dashboard, NOT here) ===
//
// IMPORTANT: config.js (this file, renamed) is served publicly. Never put
// passwords, JWT secrets, or API keys here — use Vercel environment variables.
//
// Inbox authentication (REQUIRED — both vars must be set or inbox returns 503):
//   SUPABASE_JWT_SECRET   Your Supabase project JWT secret — used to verify that
//                         only authenticated users can call /api/inbox.
//                         Found in: Supabase Dashboard → Settings → API →
//                         JWT Settings → JWT Secret (copy the full value).
//                         Without this env var the inbox endpoint returns 503.
//
//   INBOX_ALLOWED_EMAILS  REQUIRED. Comma-separated list of email addresses
//                         permitted to access the inbox. The endpoint returns 503
//                         if this var is absent or empty (default-deny). Any JWT-
//                         authenticated user NOT in this list receives HTTP 403.
//                         Example: jacquigriffin@mobilesolicitor.com.au
//
// JGMS mailbox — Microsoft 365 via Graph API (app-only client credentials):
//   JGMS_EMAIL            jacquigriffin@mobilesolicitor.com.au
//   AZURE_CLIENT_ID       Azure AD app client ID
//   AZURE_TENANT_ID       Azure AD tenant ID
//   AZURE_CLIENT_SECRET   Azure AD app client secret
//
// FLA mailbox — IMAP at mail.familylawassist.net.au:993:
//   FLA_EMAIL             hello@familylawassist.net.au
//   FLA_IMAP_PASSWORD     IMAP password for that account
//
// NTRRLS mailbox — IMAP at mail.ntruralremotelegalservices.com.au:993:
//   NTRRLS_EMAIL          hello@ntruralremotelegalservices.com.au
//   NTRRLS_IMAP_PASSWORD  IMAP password for that account
//
// All three accounts are optional and independently enabled — the API
// fetches whichever accounts have their env vars set. At least one must
// be configured for the Inbox tab to show live mail.
