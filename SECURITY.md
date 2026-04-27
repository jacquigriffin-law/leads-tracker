# LeadFlow Security Hardening — Summary

**Practice:** Jacqui Griffin — Mobile Solicitor / Family Law Assist / NT Rural Remote Legal Services
**Last updated:** 2026-04-21 (Round 4)
**Classification:** Internal — do not publish

---

## Six-axis security assessment

| Axis | Current state | Residual risk |
|---|---|---|
| **1. Where data is processed** | Lead data fetched from Supabase to browser (authenticated only). Inbox processed server-side in Vercel serverless, never stored. | Low. Email body snippets (160 chars) reach the browser; this is intentional for triage. Operational files (sql, mjs, SECURITY.md) are now blocked at CDN. |
| **2. Where data is stored / retained** | Supabase (primary, RLS-protected). `data.json` and `leads.json` remain in git history (see B6). `localStorage` holds per-user flags and comments only — no PII beyond what the user types. | Medium. Git history contains client PII until filter-repo is run (B6). localStorage on a shared/unlocked device can expose comments. |
| **3. LLM / model training** | No AI processing. No Anthropic or OpenAI calls. No data is sent to any model. Supabase does not use your data for training. | None identified. |
| **4. Who can access the data** | Leads: email-whitelist RLS policy is now the **primary** policy in `supabase-schema.sql` (broad policy demoted to commented-out). Inbox: `INBOX_ALLOWED_EMAILS` is now documented as required. | Medium until B1, B1a, B3, B4 are deployed in Supabase/Vercel. Schema file reflects correct policy; DB state depends on whether the SQL has been run. |
| **5. Least privilege / technical security** | JWT auth is now hard-mandatory on inbox. Security headers in place (CSP, HSTS, X-Frame-Options). `data.json` and `leads.json` blocked at CDN. No browser write access to `leads` table. | Medium. Inbox auth collapses to "any authenticated user" until `INBOX_ALLOWED_EMAILS` is set and Supabase sign-up is locked down (B4). |
| **6. Logging and auditability** | Inbox: every access, auth failure, rate-limit, and misconfiguration event logged as structured JSON to Vercel runtime. Database: `lead_audit_log` records every INSERT/UPDATE/DELETE on `lead_states` via security-definer trigger. `lead_access_log` records high-value authenticated client events such as batch lead loads and inbox triage actions. | Medium. No formal log review process defined (B5). No log retention service configured. |

---

## Changes made (local code — not yet deployed)

### Round 1 changes (earlier session)

| File | What changed | Risk addressed |
|---|---|---|
| `api/inbox.js` | JWT verification (HS256), rate limiting (4 req/min/IP), structured audit logging, source_account returns labels not raw mailbox addresses | Inbox was open to any internet user; internal mailbox addresses were leaked |
| `vercel.json` | 404 block for `data.json`, `leads.json`, `simple.html`, `debug.html`; security headers: X-Frame-Options, X-Content-Type-Options, HSTS, CSP, Referrer-Policy, Permissions-Policy | PII files were publicly accessible; no security headers existed |
| `app.js` | Supabase-first `loadLeads()` — no leads shown to unauthenticated visitors; `loadInbox()` sends Bearer token | Lead PII was served from a public static file regardless of auth state |
| `supabase-schema.sql` | `lead_audit_log` table + security-definer trigger; email-whitelist RLS template (commented); retention guidance with pg_cron template | No audit trail; broad RLS; no retention policy |
| `config.example.js` | Documented `SUPABASE_JWT_SECRET` env var | Missing from deployment docs |

### Round 2 changes (earlier session)

| File | What changed | Risk addressed |
|---|---|---|
| `api/inbox.js` | **JWT is now hard-mandatory**: missing `SUPABASE_JWT_SECRET` returns HTTP 503 instead of silently leaving the endpoint open. Added `INBOX_ALLOWED_EMAILS` authorisation check: after JWT verification, the authenticated email is matched against the env var list. Unrecognised users receive HTTP 403 and an `inbox.auth_denied` audit event. | Previously: if `SUPABASE_JWT_SECRET` was absent from Vercel env, the endpoint was fully open to any internet caller. Previously: any Supabase-authenticated account (including unknown sign-ups) could read all three practice inboxes. |
| `app.js` | Tracks `inboxAuthRequired` flag when inbox returns 401/403. `renderInbox()` now shows "Sign in to access the live inbox." instead of the misleading "Inbox not configured" message when auth is the issue. | Lawyers could not distinguish between "inbox not wired up" and "you need to sign in", leading to confusion and potential misconfigured deployments. |
| `.gitignore` | Added `data.json` and `leads.json` | Prevents future accidental commits of PII files. (Does not remove existing history — see B6.) |
| `config.example.js` | Added `INBOX_ALLOWED_EMAILS` documentation | New env var not documented for next deployment. |
| `supabase-rls-whitelist.sql` | New ready-to-run SQL that drops the broad read policy and creates the email-whitelist policy pre-populated with `jacquigriffin@mobilesolicitor.com.au`. | Makes B3 a one-step action rather than requiring manual SQL authoring. |

### Round 3 changes (this session)

| File | What changed | Risk addressed |
|---|---|---|
| `api/inbox.js` | HMAC comparison now uses `crypto.timingSafeEqual` (constant-time). Snippet capped at 160 chars (was 200). Added `inbox.no_mailbox_credentials` audit event when inbox returns `configured: false`. | Timing-based JWT signature oracle (low but real on low-latency deployments). Over-exposure of email body beyond triage need. Silent no-credentials state masked mis-deployments from audit logs. |
| `vercel.json` | Added 404 rules for `config.example.js`, `SECURITY.md`, `README.md`, all `*.sql`, all `*.mjs`. | These files were publicly readable and documented env var names, schema structure, email addresses, and SQL grants — useful attacker reconnaissance. |
| `config.example.js` | `INBOX_ALLOWED_EMAILS` documented as **required** (was "optional"). Added explicit warning that `config.js` is a public file — secrets must go in Vercel env. | Documentation said "optional" but code returns 503 if absent — risk of Jacqui leaving it unset believing it was safe. |
| `supabase-schema.sql` | Email-whitelist RLS policy promoted to primary (enabled). Broad "authenticated users" policy demoted to commented-out with a DROP instruction and `DANGER` label. Added `practice owner can read all audit log entries` RLS policy on `lead_audit_log`. | Fresh schema run previously created a broad-access policy. Audit log was unreadable by the practice owner — only the user who generated each row could see it. |
| `app.js` | Source filter dropdown now shows labels only (e.g. "JGMS") — was showing raw email addresses like `jacquigriffin@mobilesolicitor.com.au` in the rendered HTML. Added `clientAudit('lead.delete', ...)` to `handleDeleteLead`. | Internal mailbox addresses were visible in rendered HTML to any authenticated user with DevTools access. Lead deletions had no audit trail at any layer. |

### Round 4 changes (this session)

| File | What changed | Risk addressed |
|---|---|---|
| `supabase-schema.sql` | Added `lead_access_log` plus `log_lead_access_event(...)` security-definer RPC. Read access is limited to the acting user and the practice owner. | There was no durable application-layer access log for lead reads and inbox triage actions. |
| `app.js` | Added best-effort RPC logging for `leads.read_batch`, `inbox.import`, `inbox.dismiss`, `inbox.undismiss`, and `lead.hide_local`. Logged metadata is minimised, for example sender domain rather than full sender email. | Improved auditability without unnecessarily copying more client data into logs. |
| `app.js` | Normalised source keys in DOM/filter state so known internal mailbox addresses are no longer exposed in `data-source` attributes or filter values. | Reduced passive disclosure of internal mailbox addresses in rendered HTML / DevTools. |
| `app.js` | Inbox imports no longer duplicate message snippets into both `notes` and `raw_preview`; the snippet is stored once only. | Reduced retention and duplication of client email content on the client side. |
| `vercel.json` | Added `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and `X-Robots-Tag: noindex, nofollow, noarchive`. | Reduced framing / cross-origin exposure and reduced accidental indexing of the app. |
| `README.md` | Added production-safe posture, AI/data-handling notes, retention guidance, and pointer to `SECURITY.md`. | Setup docs previously under-explained what must stay private and how long data should be kept. |

---

## Blockers — decisions required by Jacqui / Moe

| # | Blocker | Priority | What to do |
|---|---|---|---|
| **B1** | `SUPABASE_JWT_SECRET` not in Vercel env | **CRITICAL** | Supabase Dashboard → Settings → API → JWT Settings → JWT Secret. Add to Vercel Dashboard → Project → Settings → Environment Variables as `SUPABASE_JWT_SECRET` (all environments). Without this, inbox returns 503. |
| **B1a** | `INBOX_ALLOWED_EMAILS` not set in Vercel env | **HIGH** | Add `INBOX_ALLOWED_EMAILS=jacquigriffin@mobilesolicitor.com.au` to Vercel env (all environments). This closes the gap where any Supabase-authenticated user can access the inbox. |
| **B2** | Leads not yet in Supabase `leads` table | **HIGH** | Run `node generate-supabase-import.mjs` → paste `supabase-import.sql` into Supabase SQL editor. Verify row count before deploying. |
| **B3** | RLS policy for `leads` table is too broad | **HIGH** | Run `supabase-rls-whitelist.sql` in Supabase SQL editor (pre-populated with Jacqui's email — add others as needed). |
| **B4** | Supabase sign-up not restricted | **HIGH** | Supabase Dashboard → Authentication → Settings → disable "Enable Sign Ups" (use invite-only or magic-link to known addresses only). Until this is done, any email that receives a magic link can access leads. |
| **B5** | No audit log review process | **MEDIUM** | Decide who reviews Vercel runtime logs and how often. Filter by `"audit":true` in Vercel Dashboard → Logs. For formal compliance, forward to a log retention service (Papertrail, Datadog, Logtail). |
| **B6** | PII in git history | **MEDIUM** | `data.json` and `leads.json` contain client PII and are committed to git history. Run `git filter-repo --invert-paths --path data.json --path leads.json` to rewrite history. This is destructive — coordinate with Moe, back up the repo, and force-push to the remote. |
| **B7** | Supabase anon key exposed in git | **LOW** | The `config.js` anon key was committed before `.gitignore` was applied. Rotate in Supabase Dashboard → Settings → API → Regenerate anon key, then update `config.js`. Low urgency because RLS is the primary protection layer. |

---

## Suggested next steps (priority order)

1. **[Immediate — before next inbox use]** Add `SUPABASE_JWT_SECRET` to Vercel env (B1).
2. **[Immediate]** Add `INBOX_ALLOWED_EMAILS=jacquigriffin@mobilesolicitor.com.au` to Vercel env (B1a).
3. **[Before next deploy]** Import leads into Supabase and verify row count (B2).
4. **[Before next deploy]** Deploy these code changes to production.
5. **[Within 1 week]** Run `supabase-rls-whitelist.sql` to activate email-whitelist RLS (B3).
6. **[Within 1 week]** Disable Supabase public sign-up (B4).
7. **[Within 2 weeks]** Review Vercel logs to confirm `inbox.access` and `inbox.auth_denied` events appear correctly (B5).
8. **[Within 1 month]** Rewrite git history to remove PII files (B6) and rotate anon key (B7).
9. **[Within 3 months]** Enable the `pg_cron` retention schedule from `supabase-schema.sql` for declined/no_action leads.

---

## Known gaps (out of scope / require new credentials or infrastructure)

- **Full SELECT-level lead access logging:** PostgreSQL does not support AFTER SELECT triggers. The app now records batch lead loads in `lead_access_log`, but raw table reads outside the app are still not captured automatically. Stronger options are: (a) enable `pgaudit` in Supabase if available on your plan; (b) wrap lead fetches in a `SECURITY DEFINER` function that logs and then returns rows, replacing direct `.from('leads').select(...)` calls.
- **Server-side inbox → Supabase import:** Emails imported via the UI are saved only in `localStorage`. A future improvement would write imported leads directly to the Supabase `leads` table via a server-side function using the service-role key. Requires a new serverless function; service-role key must never appear in `config.js`.
- **IMAP password rotation:** FLA and NTRRLS IMAP passwords are in Vercel env as plaintext. Rotating requires new passwords from each mail hosting provider.
- **Application-layer encryption:** `notes` and `raw_preview` fields store sensitive case details (e.g., domestic violence, child protection) in plain text in Supabase. For highest-sensitivity matters, consider encrypting these fields with a client-held key before writing to the database.
- **Device lock / session timeout:** `localStorage` on a shared or unlocked device can expose lead flags and comments. Supabase sessions auto-refresh by default (1-hour expiry). Enforce device lock via MDM or consider reducing the Supabase session lifetime in project settings.
- **Log retention:** Vercel runtime logs have a limited retention window (hours to days depending on plan). For 7-year audit retention required under NSW legal practice rules, forward logs to an external service before they age out.

---

## NSW and national legal-practice obligations

### Privacy Act 1988 (Cth) — Australian Privacy Principles

| Obligation | Principle | Action required |
|---|---|---|
| Take reasonable steps to protect personal information from misuse, interference, loss, and unauthorised access or disclosure. | APP 11.1 | Deploy RLS whitelist (B3) and restrict Supabase sign-up (B4). Set `INBOX_ALLOWED_EMAILS` (B1a). |
| Destroy or de-identify personal information no longer needed for its purpose. | APP 11.2 | Implement the pg_cron retention schedule in `supabase-schema.sql` (12-month purge for declined/no_action leads). Do NOT auto-purge actioned leads — those are matter files subject to a 7-year minimum. |
| Notify the OAIC and affected individuals of an eligible data breach without unreasonable delay (≤30 days where practicable). | Notifiable Data Breaches scheme (s.26WK–26WL Privacy Act) | Assess in writing whether prior public accessibility of `data.json` / `leads.json` constitutes an eligible data breach. If yes, notify the OAIC and affected clients. Engage the NSW Law Society ethics line (02 9926 0114) before deciding. |
| Collect only personal information reasonably necessary for the practice's functions. | APP 3.3 | The inbox endpoint returns a curated subset of email fields only. Review annually. |

### Legal Profession Uniform Law (NSW) 2014 — relevant obligations

| Obligation | Source | Action required |
|---|---|---|
| Maintain client confidentiality; take reasonable precautions against inadvertent disclosure. | LPU Rule 9 (Uniform Conduct Rules) | Confirm only authorised practice members can sign in (B4 — restrict Supabase sign-up). Confirm RLS whitelist (B3) is active before client matters are entered in the system. |
| Matter files and client records must be retained for a minimum of 7 years after matter closure (or until the client turns 25 for matters involving minors). | NSW Law Society Practice Management guidance; LPU Rule 14 | Do NOT apply the 12-month purge to leads with `status = 'actioned'`. Tag those as matter records and keep for 7 years post-closure. |
| Lawyers using cloud services must take reasonable steps to ensure those services meet Australian privacy law requirements, including data residency in Australia where practicable. | NSW Law Society Cloud Storage Guidance (2021) | Confirm Supabase stores data in `ap-southeast-2` (Sydney, AU). Check in Supabase Dashboard → Settings → Infrastructure. Document the region in the practice's data register. |

### Mandatory NSW-practice checklist

- [ ] **SUPABASE_JWT_SECRET** added to Vercel env (B1) — inbox protection is inactive without this
- [ ] **INBOX_ALLOWED_EMAILS** set in Vercel env (B1a) — without this, any Supabase-authenticated user can read all three practice inboxes
- [ ] **Supabase sign-up restricted** (B4) — Supabase Dashboard → Authentication → Settings → disable "Enable Sign Ups"
- [ ] **RLS whitelist deployed** (B3) — run `supabase-rls-whitelist.sql` in Supabase SQL editor
- [ ] **Data breach assessment documented in writing** — assess the prior public accessibility of data.json/leads.json against the NDB Scheme criteria; record the assessment outcome regardless of conclusion
- [ ] **Supabase data residency confirmed** — check `ap-southeast-2` in Supabase Dashboard → Settings → Infrastructure; note in practice data register
- [ ] **Retention schedule set** — implement pg_cron from `supabase-schema.sql` or set a calendar reminder for annual manual review; ensure actioned leads are excluded from the 12-month purge

---

## LLM / AI privacy controls (Round 5)

### Policy statement

**No full email bodies or attachments are ever sent to an LLM.** Emails are treated as untrusted data sources. Any future AI integration must follow the pipeline below without exception.

### Required pipeline for any LLM processing of email or lead data

```
Raw email body
  → minimiseBody()      — strip quotes, signatures, truncate to ≤300 chars
  → detectInjection()   — abort if prompt-injection patterns detected; log the block
  → redactPii()         — replace phone, email, ABN, TFN, URLs with typed placeholders
  → LLM prompt          — subject + redacted snippet only; no names, no full content
  → validateLlmOutput() — enforce JSON extraction schema; reject any extra fields
  → Human review        — practitioner must review before any output is actioned
  → log_llm_processing() — log to llm_processing_log (metadata only, no PII)
```

All utilities are in `api/lib/email-privacy.js`. The JSON extraction schema (`LLM_EXTRACTION_SCHEMA`) defines the only fields an LLM may return. `requires_human_review` is enforced as `true` at both the schema and database insert level.

### What the inbox API exposes

`/api/inbox` returns per-email flags alongside each message:

| Field | Type | Meaning |
|---|---|---|
| `injection_risk` | `boolean` | True if the snippet triggered a prompt-injection pattern. Do not send to an LLM. |
| `redacted_pii` | `boolean` | True if PII (phone, email, ABN, TFN, URL) was detected in the snippet. |

Both flags are set by `api/lib/email-privacy.js` at response-build time. The live inbox response never contains full bodies or attachments.

### Audit log

`supabase-llm-audit.sql` provisions the `llm_processing_log` table:

- Least-privilege: `authenticated` role has SELECT only; inserts flow through `log_llm_processing()` (security definer).
- RLS: each user reads their own rows; practice owner reads all rows.
- `requires_human_review` is set to `true` by the insert function regardless of caller input.
- Retention: 7 years minimum (NSW LPU Rule 14).
- Never stores raw email content or extracted PII — summaries and metadata only.

### Prompt-injection protection

Emails are untrusted input. Common injection patterns (e.g. "ignore previous instructions", "act as", INST tokens, im_start tokens) are blocked before any LLM call. Blocked events are audited with `inbox.injection_risk_detected` in Vercel runtime logs.

### Human-review requirement

LLM output is a triage hint only. No extracted field (matter type, urgency, location) may be acted upon without practitioner review and sign-off. This requirement is:
- Documented in `LLM_EXTRACTION_SCHEMA` (`requires_human_review: true`, `const: true`)
- Enforced at the database layer (`log_llm_processing()` always sets `requires_human_review = true`)
- Displayed to the user via the `human_review_warning` field in validated LLM output

### Files added in Round 5

| File | Purpose |
|---|---|
| `api/lib/email-privacy.js` | Reusable server-side utilities: `minimiseBody`, `redactPii`, `detectInjection`, `buildLlmInput`, `validateLlmOutput`, `LLM_EXTRACTION_SCHEMA` |
| `supabase-llm-audit.sql` | `llm_processing_log` table, RLS, security-definer insert function, retention guidance |
| `scripts/test-email-privacy.js` | Verification script — exercises all privacy utilities against sample emails including prompt-injection text |
