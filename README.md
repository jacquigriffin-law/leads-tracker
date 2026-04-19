# Leads Tracker, Supabase-ready

This keeps the current static tracker workflow, but adds an optional Supabase mode.

## What changed

- `index.html` still serves the same tracker UI and workflow.
- `app.js` now renders leads from data and supports two modes:
  - **Local mode**: default, no config required, stores checklist/comments in browser localStorage.
  - **Supabase mode**: enabled only when `config.js` is present with a Supabase URL and anon key.
- Existing localStorage state from the old tracker is migrated automatically.
- You can still import/export tracker state as JSON.
- You can temporarily import a `data.json` style file in-browser.

## Files

- `index.html` - tracker shell and unchanged look/feel
- `app.js` - data loading, filtering, rendering, local/Supabase sync
- `config.example.js` - copy to `config.js` and fill in values
- `supabase-schema.sql` - tables, RLS, policies, trigger
- `generate-supabase-import.mjs` - converts `data.json` into SQL inserts

## Local mode

Do nothing. If `config.js` is absent, the app runs locally and safely.

State keys are now stored under `xena-leads-state-v4`.
Old `xena-leads-state-v3` data is migrated automatically when leads load.

## Supabase mode setup

1. Create a Supabase project.
2. In Supabase Auth, enable **Email OTP / magic links**.
3. In URL configuration, add your deployed tracker URL as a redirect URL.
4. Run `supabase-schema.sql` in the SQL editor.
5. Copy `config.example.js` to `config.js`.
6. Put in:
   - project URL
   - **anon** key only
7. Deploy `config.js` with the site.

Important:
- Do **not** put the service role key in `config.js` or any browser file.
- This app is designed for the public anon key plus RLS.

## Importing existing lead data into Supabase

### Option A, from current `data.json`

Run:

```bash
cd /opt/openclaw/clients/jacqui-griffin/leads-tracker
node generate-supabase-import.mjs data.json
```

That writes `supabase-import.sql`. Paste that into Supabase SQL editor and run it.

### Option B, from browser import

Use **Import leads JSON** in the tracker to test a JSON file in-browser first.
That import is local-only until you also load the data into Supabase.

## Importing existing localStorage state

### Old tracker state already on this device

Just open the new tracker once. It auto-migrates the old `xena-leads-state-v3` keys.

### Export/import path

1. In the old tracker, export state if needed.
2. In the new tracker, click **Import state**.
3. The app accepts:
   - legacy export format: `{ version: "xena-leads-v1", data: ... }`
   - new export format: `{ state: ... }`

If Supabase mode is active and the user is signed in, imported state is also upserted to `lead_states`.

## Inbox (live email)

The `/api/inbox` endpoint aggregates up to three mailboxes. Set env vars in the Vercel dashboard — at least one mailbox must be configured for the Inbox tab to show live mail. All three are optional and independently enabled.

### JGMS — Microsoft 365 (jacquigriffin@mobilesolicitor.com.au)

Uses the existing Azure app (client credentials / app-only flow, same as the PA assistant scripts).

| Env var | Value |
|---|---|
| `JGMS_EMAIL` | `jacquigriffin@mobilesolicitor.com.au` |
| `AZURE_CLIENT_ID` | Azure AD app client ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_SECRET` | Azure AD app client secret |

Required Azure app permission: `Mail.Read` (application).

### FLA — IMAP (hello@familylawassist.net.au)

| Env var | Value |
|---|---|
| `FLA_EMAIL` | `hello@familylawassist.net.au` |
| `FLA_IMAP_PASSWORD` | IMAP password (host: `mail.familylawassist.net.au` port 993) |

### NTRRLS — IMAP (hello@ntruralremotelegalservices.com.au)

| Env var | Value |
|---|---|
| `NTRRLS_EMAIL` | `hello@ntruralremotelegalservices.com.au` |
| `NTRRLS_IMAP_PASSWORD` | IMAP password (host: `mail.ntruralremotelegalservices.com.au` port 993) |

Each email in the combined inbox carries a `mailbox` key (`jgms` / `fla` / `ntrrls`) and `source_account` (the recipient address), both visible in the card "to" field and preserved when importing as a lead. Results are merged and sorted newest-first.

## Security model

- `leads` is read-only to authenticated users.
- `lead_states` is per-user via `auth.uid() = user_id`.
- Browser only uses Supabase anon key.
- Service role key stays server-side only.

## Notes

- The UI stays materially the same, but is now data-driven instead of hardcoded rows.
- If Supabase is enabled but nobody is signed in, the app falls back to local `data.json` until sign-in completes.
- For permanent multi-user shared lead content, update `data.json` and/or import the same rows into Supabase `leads`.
