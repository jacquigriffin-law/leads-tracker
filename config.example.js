window.LEADS_CONFIG = {
  supabase: {
    enabled: false,
    url: 'https://YOUR_PROJECT.supabase.co',
    anonKey: 'YOUR_SUPABASE_ANON_KEY'
  }
};

// === Inbox env vars (set in Vercel dashboard, NOT here) ===
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
