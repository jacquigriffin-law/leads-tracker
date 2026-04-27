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

- `leads` is intended to be read-only to an explicit email allow-list of authorised users.
- `lead_states` is per-user via `auth.uid() = user_id`.
- `lead_audit_log` records changes to `lead_states`.
- `lead_access_log` records significant access events via `log_lead_access_event(...)`, including lead batch loads and inbox import/dismiss actions.
- Browser only uses Supabase anon key.
- Service role key stays server-side only.

## Production-safe posture

- Treat `data.json` and `leads.json` as local migration files only, not a live hosted data source.
- In production, `vercel.json` blocks public access to `data.json`, `leads.json`, SQL files, local docs, and helper scripts.
- `/api/inbox` is default-deny. It requires:
  - a valid Supabase JWT in the `Authorization` header
  - `SUPABASE_JWT_SECRET` in Vercel env
  - `INBOX_ALLOWED_EMAILS` in Vercel env
- Inbox responses are minimised for triage. They return snippets only, not full message bodies.
- Inbox-imported leads store the snippet once in `raw_preview`; they do not duplicate it into `notes`.

## AI extraction (`/api/ai-triage`)

Optional serverless endpoint that classifies one inbox item using OpenAI. **Disabled by default** — the endpoint returns 503 until all three policy env vars are explicitly set.

### Required env vars

| Env var | Required value | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openai` | Selects the AI provider — only `openai` is accepted |
| `LLM_POLICY_CONFIRMED` | `true` | Explicit operator acknowledgement that the AI policy has been reviewed |
| `OPENAI_API_KEY` | your key | OpenAI API key — never put this in `config.js` |
| `OPENAI_MODEL` | `gpt-4o-mini` (default) | Model to use — defaults to `gpt-4o-mini` if unset |

All four vars must be set in **Vercel env** (not `config.js`). If any of the first three are absent or wrong, the endpoint returns HTTP 503 immediately.

### Auth

Same JWT + `INBOX_ALLOWED_EMAILS` allowlist as `/api/inbox`. Default-deny: missing or empty `INBOX_ALLOWED_EMAILS` returns 503.

### What is sent to OpenAI

Only the minimised, PII-redacted snippet, the redacted subject line, and the source label (e.g. `FLA`). The following are **never** sent:

- Full email bodies or attachments
- `from_name` or `from_email` (accepted in the request body for audit logging only)
- Any un-redacted phone numbers, email addresses, ABNs, TFNs, or URLs
- Items where `injection_risk: true` was flagged by the inbox API

### `store: false`

Every OpenAI call includes `store: false`, requesting that OpenAI not retain the conversation in its API history.

### Output

Returns a validated triage object:

```json
{
  "extraction": {
    "matter_type_guess": "family_law",
    "urgency_guess": "urgent",
    "location_mentioned": "NSW",
    "requires_human_review": true,
    "human_review_warning": "Triage hint only. Practitioner review required before acting."
  },
  "meta": {
    "model": "gpt-4o-mini",
    "store": false,
    "redacted_pii": true,
    "injection_risk": false,
    "requires_human_review": true
  }
}
```

`requires_human_review` is always `true`. The endpoint never sends a reply or takes any action — it returns a draft for practitioner review only.

### Safety rules

1. If `injection_risk: true` is set on the inbox item, **do not call this endpoint**. The server will also abort and log the attempt if an injected snippet reaches it.
2. Output must not be actioned without practitioner review — it is a triage hint only.
3. All LLM call metadata is logged to `llm_processing_log` in Supabase via the `log_llm_processing()` security-definer RPC. No raw email content or PII is stored in that table.
4. Rate-limited to 5 requests per IP per minute (lower than inbox because each call is billable).

## Data handling, retention, and AI

### No raw email data to LLMs

This app does **not** currently send lead data to an LLM or AI provider.

If a future integration is added, it **must** follow the privacy pipeline in `api/lib/email-privacy.js`:

1. `minimiseBody()` — strip quoted replies and signatures, truncate to ≤300 chars
2. `detectInjection()` — abort and log if prompt-injection patterns are found; **never proceed**
3. `redactPii()` — replace phones, emails, ABNs, TFNs, and URLs with typed placeholders
4. LLM call — subject + redacted snippet only; full bodies and attachments are prohibited
5. `validateLlmOutput()` — enforce the JSON extraction schema; reject unexpected fields
6. Human review — a practitioner must review before any LLM output is actioned
7. `log_llm_processing()` — record metadata in `llm_processing_log` (no raw content)

**Emails are untrusted data.** Prompt-injection text embedded in an email would be forwarded verbatim to an LLM if the pipeline above is bypassed. The `detectInjection` step is non-optional.

### Inbox response privacy flags

Each email returned by `/api/inbox` carries two flags:

- `injection_risk: true` — the snippet matched a prompt-injection pattern. Do not pass to an LLM.
- `redacted_pii: true` — PII was detected in the snippet (phone, email, ABN, TFN, or URL).

These flags are set server-side by `api/lib/email-privacy.js` and are informational for the UI and any downstream caller.

### JSON-only extraction contract

Any LLM integration must return only the fields defined in `LLM_EXTRACTION_SCHEMA` (exported from `api/lib/email-privacy.js`). The schema enforces:

- A closed enum for `matter_type_guess` and `urgency_guess`
- `requires_human_review: true` (constant — LLM may not set this to false)
- A mandatory `human_review_warning` string shown to the practitioner
- No additional properties permitted

### Storage

- Supabase is the intended primary store for lead records.
- Browser `localStorage` should contain only per-user state: flags, dismissals, and comments.
- `llm_processing_log` records LLM call metadata only — no raw email content or extracted PII.

### Retention

- Declined / no-action leads: 12 months
- Actioned leads that become matter records: retain per matter-file rules, typically 7 years after closure
- Audit logs (`lead_audit_log`, `lead_access_log`, `llm_processing_log`): 7 years minimum (NSW LPU Rule 14)

See `SECURITY.md` for the full hardening note, LLM privacy pipeline, blocker list, and residual risks.

## Notes

- The UI stays materially the same, but is now data-driven instead of hardcoded rows.
- If Supabase is enabled but nobody is signed in, the app falls back to local `data.json` until sign-in completes.
- For permanent multi-user shared lead content, update `data.json` and/or import the same rows into Supabase `leads`.
