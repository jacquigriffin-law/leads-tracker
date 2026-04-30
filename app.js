// ── Storage keys — live production (never share with demo) ──────────────────
const LEGACY_STORAGE_KEY = 'xena-leads-state-v3';
const STATE_STORAGE_KEY = 'xena-leads-state-v4';
const MAGIC_LINK_COOLDOWN_KEY = 'xena-leads-magic-link-cooldown-until';
const MAGIC_LINK_COOLDOWN_MS = 60 * 1000;
const CONFIG_PATH = './config.js';
const INBOX_IMPORTED_KEY = 'xena-leads-inbox-imported';
const INBOX_DISMISSED_KEY = 'xena-leads-inbox-dismissed';
const INBOX_SHOW_DISMISSED_KEY = 'xena-leads-inbox-show-dismissed';
const PENDING_HERO_FILTER_KEY = 'xena-leads-pending-hero-filter';
const MANUAL_LEADS_KEY = 'xena-leads-manual-drafts-v1';
const DEFAULT_CONFIG = {
  supabase: {
    enabled: true,
    url: 'https://lviislwimdvxuuvmvzfn.supabase.co',
    anonKey: 'sb_publishable_LAfGPgLAjPLDt3uPmJncfg_Q_Wq3-wW'
  }
};
const INBOX_POLL_MS = 45_000;
const INBOX_API_TIMEOUT_MS = 20000;

// ── Prospective client lifecycle ─────────────────────────────────────────────
const PROSPECT_STATUSES = [
  { value: '',                   label: 'No status set' },
  { value: 'new_lead',           label: 'New lead' },
  { value: 'contacted',          label: 'Contacted' },
  { value: 'awaiting_reply',     label: 'Awaiting reply' },
  { value: 'awaiting_documents', label: 'Awaiting documents' },
  { value: 'awaiting_legal_aid', label: 'Awaiting Legal Aid' },
  { value: 'ready_for_leap',     label: 'Ready to Open Matter' },
  { value: 'opened_in_leap',     label: 'Opened in LEAP' },
  { value: 'existing_matter',    label: 'Existing matter' },
  { value: 'not_a_lead',         label: 'Not a lead' },
  { value: 'declined',           label: 'Declined / no capacity' },
  { value: 'closed_no_response', label: 'Closed / no response' },
];
const PROSPECT_TERMINAL_STATUSES = new Set(['opened_in_leap', 'existing_matter', 'not_a_lead', 'declined', 'closed_no_response']);
// Days after which a lead is considered stale for a given status
const FOLLOWUP_STALE_DAYS = {
  new_lead:           1,
  contacted:          2,
  awaiting_reply:     3,
  awaiting_documents: 7,
  awaiting_legal_aid: 14,
};
const FOLLOWUP_REPLY_HINTS = [
  'follow up',
  'following up',
  'just following up',
  'checking in',
  'any update',
  'please advise',
  'please see attached',
  'attached',
  'documents',
  'forms',
  'legal aid',
  'reply',
  'called',
  'voicemail',
  'can you call',
  'thank you',
  'thanks',
];

// ── DOM element refs ─────────────────────────────────────────────────────────
const els = {
  heroSub: document.getElementById('heroSub'),
  lastUpdatedLine: document.getElementById('lastUpdatedLine'),
  syncStatusLine: document.getElementById('syncStatusLine'),
  updateNowLink: document.getElementById('updateNowLink'),
  showAuthBtn: document.getElementById('showAuthBtn'),
  authPanel: document.getElementById('authPanel'),
  authEmail: document.getElementById('authEmail'),
  authStatus: document.getElementById('authStatus'),
  sendMagicLinkBtn: document.getElementById('sendMagicLinkBtn'),
  signOutBtn: document.getElementById('signOutBtn'),
  notice: document.getElementById('notice'),
  search: document.getElementById('search'),
  sourceFilter: document.getElementById('sourceFilter'),
  dateFilter: document.getElementById('dateFilter'),
  urgencyFilter: document.getElementById('urgencyFilter'),
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  filterToggle: document.getElementById('filterToggle'),
  filterToggleLabel: document.getElementById('filterToggleLabel'),
  filterPanel: document.getElementById('filterPanel'),
  heroFilterIndicator: document.getElementById('heroFilterIndicator'),
  heroStatUrgent: document.getElementById('heroStatUrgent'),
  heroStatNew: document.getElementById('heroStatNew'),
  heroStatAging: document.getElementById('heroStatAging')
};

// ── App state ────────────────────────────────────────────────────────────────
const app = {
  config: DEFAULT_CONFIG,
  supabase: null,
  session: null,
  currentTab: 'new_leads',
  heroFilter: 'all',
  leads: [],
  lastUpdated: '',
  state: {},
  sourceOptions: [],
  remoteLeadIds: new Set(),
  authPanelOpen: false,
  inbox: [],
  inboxAccount: '',
  inboxAccounts: [],
  inboxLive: false,
  inboxAuthRequired: false,
  inboxImported: new Set(),
  inboxDismissed: new Set(),
  inboxShowDismissed: false,
  inboxPollTimer: null,
  inboxPrevUnread: -1,
  inboxLastChecked: null,
  inboxTransientError: false,
  inboxHiddenCount: 0,
  expandedLeads: new Set(),
  hasLoggedLeadRead: false,
  aiTriageAvailable: false,
  aiTriageDrafts: {},
  aiTriageLoading: new Set(),
};

// ── Utilities ────────────────────────────────────────────────────────────────
function showNotice(message, kind = 'info') {
  els.notice.hidden = !message;
  if (!message) return;
  els.notice.textContent = message;
  els.notice.style.background = kind === 'error' ? '#fef2f2' : '#fff7ed';
  els.notice.style.color = kind === 'error' ? '#991b1b' : '#9a3412';
  els.notice.style.borderColor = kind === 'error' ? '#fecaca' : '#fed7aa';
}

function setSyncStatus(message) {
  if (!els.syncStatusLine) return;
  els.syncStatusLine.textContent = message;
}

function setDefaultSyncStatus() {
  setSyncStatus(app.supabase ? (app.session ? 'Syncing across devices' : 'Saved on this phone') : 'Saved on this phone');
}

function getMagicLinkCooldownRemainingMs() {
  const cooldownUntil = Number(localStorage.getItem(MAGIC_LINK_COOLDOWN_KEY) || 0);
  return Math.max(0, cooldownUntil - Date.now());
}

function setMagicLinkCooldown(ms = MAGIC_LINK_COOLDOWN_MS) {
  localStorage.setItem(MAGIC_LINK_COOLDOWN_KEY, String(Date.now() + ms));
}

function parseLeadDate(value) {
  if (!value) return null;
  if (value.includes('/')) {
    const parts = value.split('/');
    if (parts.length === 3) return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]), 12, 0, 0, 0);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLeadDate(value) {
  const date = value instanceof Date ? value : parseLeadDate(value);
  if (!date) return '';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function formatDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function timeAgo(date) {
  if (!date) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return 'today';
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getEmailDomain(value) {
  const email = String(value || '').trim().toLowerCase();
  const at = email.indexOf('@');
  return at > -1 ? email.slice(at + 1) : '';
}

function getSourceMeta(source) {
  const value = String(source || '').trim();
  const normalized = value.toLowerCase();
  if (normalized === 'jacquigriffin@mobilesolicitor.com.au' || normalized === 'jgms') {
    return { key: 'jgms', label: 'JGMS', className: 'source-jgms' };
  }
  if (normalized === 'hello@ntruralremotelegalservices.com.au' || normalized === 'ntrrls') {
    return { key: 'ntrrls', label: 'NTRRLS', className: 'source-ntr' };
  }
  if (normalized === 'hello@familylawassist.net.au' || normalized === 'fla') {
    return { key: 'fla', label: 'FLA', className: 'source-fla' };
  }
  if (normalized === 'finchly/lawconnect') {
    return { key: 'finchly-lawconnect', label: 'Finchly/LawConnect', className: 'source-fla' };
  }
  if (normalized === 'sms') {
    return { key: 'sms', label: 'SMS Forward', className: '' };
  }
  if (!value) {
    return { key: 'unknown', label: 'Unknown', className: '' };
  }
  const safeKey = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  const safeLabel = value.length > 32 ? `${value.slice(0, 29)}…` : value;
  return { key: `other-${safeKey}`, label: safeLabel, className: '' };
}

function getLeadSourceValue(lead) {
  return lead.source_account || lead.source_platform || 'Unknown';
}

// ── Audit / security logging ─────────────────────────────────────────────────
// Structured client-side audit. Matches JSON shape in api/inbox.js for consistency.
// Browser console logs are not durable — for compliance, also review Vercel runtime
// logs (server-side) and the Supabase lead_audit_log table.
function clientAudit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), user: app.session?.user?.email || 'unauthenticated', ...details }));
}

async function logSecurityEvent(eventType, targetId = null, metadata = {}) {
  clientAudit(eventType, { targetId, ...metadata });
  if (!(app.supabase && app.session)) return;
  try {
    const { error } = await app.supabase.rpc('log_lead_access_event', {
      p_event_type: eventType,
      p_target_id: targetId ? String(targetId) : null,
      p_metadata: metadata
    });
    if (error) throw error;
  } catch (error) {
    console.warn('Security event log failed', error);
  }
}

// ── Lead state ───────────────────────────────────────────────────────────────
function getLeadId(lead, index) {
  return String(lead.id ?? lead.lead_id ?? index + 1);
}

function getLeadState(id) {
  return app.state[id] || { actioned: false, leap: false, noAction: false, laAccepted: false, hidden: false, comment: '', prospectiveStatus: '', followUpDate: '' };
}

function hasMeaningfulState(state) {
  return Boolean(
    state?.actioned ||
    state?.leap ||
    state?.noAction ||
    state?.laAccepted ||
    state?.hidden ||
    String(state?.comment || '').trim() ||
    String(state?.prospectiveStatus || '').trim()
  );
}

function isProspectStale(lead, state) {
  const status = state.prospectiveStatus;
  if (!status || !FOLLOWUP_STALE_DAYS[status]) return false;
  const leadDate = parseLeadDate(lead.date_received);
  if (!leadDate) return false;
  const daysSince = (Date.now() - leadDate.getTime()) / 86400000;
  return daysSince > FOLLOWUP_STALE_DAYS[status];
}

function getStatusBadgeClass(value) {
  const map = {
    new_lead:           'new-lead',
    contacted:          'contacted',
    awaiting_reply:     'awaiting-reply',
    awaiting_documents: 'awaiting-documents',
    awaiting_legal_aid: 'awaiting-legal-aid',
    ready_for_leap:     'ready-for-leap',
    opened_in_leap:     'opened-in-leap',
    existing_matter:    'existing-matter',
    not_a_lead:         'not-a-lead',
    declined:           'declined',
    closed_no_response: 'closed-no-response',
  };
  return map[value] ? `status-badge status-badge-${map[value]}` : '';
}

function getProspectStatusLabel(value) {
  return PROSPECT_STATUSES.find((status) => status.value === value)?.label || 'No status set';
}

function parseDateOnly(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatDateOnly(value) {
  const date = value instanceof Date ? value : parseDateOnly(value);
  if (!date) return '';
  return date.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function getDaysUntil(date) {
  if (!date) return null;
  return Math.floor((date.getTime() - Date.now()) / 86400000);
}

function isLeadReadyForLeap(state) {
  return state.prospectiveStatus === 'ready_for_leap';
}

function getFollowUpPriority(lead, state) {
  if (!state.prospectiveStatus || PROSPECT_TERMINAL_STATUSES.has(state.prospectiveStatus)) return null;

  if (isLeadReadyForLeap(state)) {
    return { bucket: 'ready', label: 'Ready to Open Matter' };
  }

  const followUpDate = parseDateOnly(state.followUpDate);
  const daysUntil = getDaysUntil(followUpDate);
  if (followUpDate && daysUntil !== null && daysUntil <= 0) {
    return { bucket: 'due', label: daysUntil < 0 ? `Overdue since ${formatDateOnly(followUpDate)}` : 'Due today' };
  }

  if (isProspectStale(lead, state)) {
    return { bucket: 'stale', label: 'Stale follow-up' };
  }

  return null;
}

function getPipelineTab(lead, state) {
  if (state.actioned || state.noAction ||
      PROSPECT_TERMINAL_STATUSES.has(state.prospectiveStatus)) return 'closed';
  if (state.prospectiveStatus === 'ready_for_leap') return 'ready';
  if (['contacted', 'awaiting_reply', 'awaiting_documents', 'awaiting_legal_aid'].includes(state.prospectiveStatus)) return 'followup';
  return 'new_leads';
}

function renderStageActions(pipelineTab, id) {
  const eid = escapeHtml(id);
  if (pipelineTab === 'new_leads') {
    return `<div class="pipeline-actions pipeline-actions-new">
      <span class="pipeline-actions-label">Move this lead</span>
      <div class="pipeline-btns">
        <button class="btn-pipeline btn-pipeline-primary" type="button" data-pipeline-action="contacted" data-pipeline-id="${eid}">&#10003; Contacted</button>
        <button class="btn-pipeline btn-pipeline-neutral" type="button" data-pipeline-action="not_a_lead" data-pipeline-id="${eid}">&#10005; Not a lead</button>
        <button class="btn-pipeline btn-pipeline-neutral" type="button" data-pipeline-action="existing_matter" data-pipeline-id="${eid}">Existing matter</button>
        <button class="btn-pipeline btn-pipeline-danger" type="button" data-pipeline-action="decline" data-pipeline-id="${eid}">Decline</button>
      </div>
    </div>`;
  }
  if (pipelineTab === 'followup') {
    return `<div class="pipeline-actions pipeline-actions-followup">
      <span class="pipeline-actions-label">Update status</span>
      <div class="pipeline-btns">
        <button class="btn-pipeline btn-pipeline-status" type="button" data-pipeline-action="awaiting_reply" data-pipeline-id="${eid}">Awaiting reply</button>
        <button class="btn-pipeline btn-pipeline-status" type="button" data-pipeline-action="awaiting_documents" data-pipeline-id="${eid}">Awaiting docs</button>
        <button class="btn-pipeline btn-pipeline-status" type="button" data-pipeline-action="awaiting_legal_aid" data-pipeline-id="${eid}">Awaiting Legal Aid</button>
      </div>
      <div class="pipeline-btns">
        <button class="btn-pipeline btn-pipeline-primary" type="button" data-pipeline-action="ready_for_leap" data-pipeline-id="${eid}">&#10003; Ready to Open Matter</button>
        <button class="btn-pipeline btn-pipeline-danger" type="button" data-pipeline-action="close" data-pipeline-id="${eid}">Close / No response</button>
      </div>
    </div>`;
  }
  if (pipelineTab === 'ready') {
    return `<div class="pipeline-actions pipeline-actions-ready">
      <span class="pipeline-actions-label">Next step</span>
      <div class="pipeline-btns">
        <button class="btn-pipeline btn-pipeline-primary" type="button" data-pipeline-action="opened_in_leap" data-pipeline-id="${eid}">&#10003; Opened in LEAP</button>
        <button class="btn-pipeline btn-pipeline-warning" type="button" data-pipeline-action="needs_more_info" data-pipeline-id="${eid}">&#8592; Needs more info</button>
        <button class="btn-pipeline btn-pipeline-danger" type="button" data-pipeline-action="close" data-pipeline-id="${eid}">Close</button>
      </div>
    </div>`;
  }
  return '';
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getLocalDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function inboxLooksLikeProspectiveFollowUp(email) {
  const subject = String(email?.subject || '').toLowerCase();
  const snippet = String(email?.snippet || '').toLowerCase();
  const fromName = String(email?.from_name || '').toLowerCase();
  if (!subject && !snippet) return false;
  if (/^re\s*:|^fw\s*:|^fwd\s*:/.test(subject)) return true;
  const haystack = `${subject}\n${snippet}\n${fromName}`;
  return FOLLOWUP_REPLY_HINTS.some((hint) => haystack.includes(hint));
}

function inboxMatchesExistingLead(email) {
  const fromEmail = String(email?.from_email || '').trim().toLowerCase();
  const phone = normalizePhone(email?.phone);
  const fromName = normalizeName(email?.from_name);
  return app.leads.some((lead) => {
    const leadEmail = String(lead.sender_email || '').trim().toLowerCase();
    const leadPhone = normalizePhone(lead.sender_phone || lead.phone);
    const leadName = normalizeName(lead.sender_name);
    return (fromEmail && leadEmail && fromEmail === leadEmail) ||
      (phone && leadPhone && phone === leadPhone) ||
      (fromName && leadName && fromName === leadName);
  });
}


function inboxEmailHasLeadRecord(email) {
  const emailId = String(email?.id || '');
  const fromEmail = String(email?.from_email || '').trim().toLowerCase();
  const subject = String(email?.subject || '').trim().toLowerCase();
  return app.leads.some((lead) => {
    const leadId = String(lead.id || '');
    const leadEmail = String(lead.sender_email || '').trim().toLowerCase();
    const leadSubject = String(lead.subject || '').trim().toLowerCase();
    return (emailId && leadId === emailId) ||
      (fromEmail && subject && leadEmail === fromEmail && leadSubject === subject);
  });
}

function getUnmatchedFollowUpInboxItems() {
  return app.inbox.filter((email) => (
    (!app.inboxImported.has(String(email.id)) || !inboxEmailHasLeadRecord(email)) &&
    !app.inboxDismissed.has(String(email.id)) &&
    inboxLooksLikeProspectiveFollowUp(email) &&
    !inboxMatchesExistingLead(email)
  ));
}

function getVisibleLeads() {
  return app.leads.filter((lead, index) => !getLeadState(getLeadId(lead, index)).hidden);
}

function setLeadState(id, patch) {
  app.state[id] = { ...getLeadState(id), ...patch };
  persistLocalState();
}

function persistLocalState() {
  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(app.state));
}

function loadLocalState() {
  const current = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || '{}');
  app.state = current && typeof current === 'object' ? current : {};
}

function migrateLegacyState() {
  const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
  if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return;
  const nextState = { ...app.state };
  app.leads.forEach((lead, index) => {
    const id = getLeadId(lead, index);
    nextState[id] = {
      actioned: Boolean(legacy[`actioned-${index}`]),
      leap: Boolean(legacy[`leap-${index}`]),
      noAction: Boolean(legacy[`noAction-${index}`]),
      laAccepted: Boolean(legacy[`laAccepted-${index}`]),
      comment: legacy[`comment-${index}`] || ''
    };
  });
  app.state = nextState;
  persistLocalState();
}

// ── Manual leads (device-only drafts) ────────────────────────────────────────
function loadManualLeads() {
  try {
    const raw = localStorage.getItem(MANUAL_LEADS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveManualLeads(leads) {
  localStorage.setItem(MANUAL_LEADS_KEY, JSON.stringify(leads));
}

function mergeManualLeadsIntoApp() {
  app.leads = app.leads.filter((l) => !l._isManualDraft);
  const manual = loadManualLeads().map((l) => ({ ...l, _isManualDraft: true }));
  app.leads = [...manual, ...app.leads];
}

function removeManualLead(leadId) {
  saveManualLeads(loadManualLeads().filter((l) => l.id !== leadId));
}

function addManualLead(formData) {
  const id = `manual-${Date.now()}`;
  const lead = {
    id,
    sender_name: String(formData.name || '').trim() || 'Unknown',
    sender_phone: String(formData.phone || '').trim() || 'Unknown',
    sender_email: String(formData.email || '').trim() || 'Unknown',
    source_account: String(formData.source || 'Manual Entry'),
    source_platform: 'Manual',
    matter_type: String(formData.matterType || '') || 'Unknown',
    priority: String(formData.urgency || 'MEDIUM'),
    date_received: new Date().toISOString(),
    location: String(formData.location || ''),
    notes: String(formData.notes || ''),
    next_action: String(formData.nextAction || '').trim() || 'Follow up',
    status: 'new',
    raw_preview: String(formData.notes || '')
  };
  const manual = loadManualLeads();
  manual.unshift(lead);
  saveManualLeads(manual);
  return lead;
}

const ADD_LEAD_MODAL_HTML = `
  <div id="addLeadModal" class="add-lead-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="addLeadTitle">
    <div class="add-lead-card">
      <div class="add-lead-header">
        <span class="add-lead-title" id="addLeadTitle">&#43; Add Lead</span>
        <button class="add-lead-close" data-close-add-lead aria-label="Close">&times;</button>
      </div>
      <div class="add-lead-notice">&#128190; Manual draft &mdash; saved on this device only, not sent anywhere</div>
      <form id="addLeadForm" autocomplete="off">
        <div class="add-lead-form-grid">
          <div class="add-lead-field span2">
            <label class="add-lead-label" for="alName">Name *</label>
            <input id="alName" name="name" type="text" placeholder="Full name" required/>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alPhone">Phone</label>
            <input id="alPhone" name="phone" type="tel" placeholder="04xx xxx xxx"/>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alEmail">Email</label>
            <input id="alEmail" name="email" type="email" placeholder="email@example.com"/>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alSource">Source</label>
            <select id="alSource" name="source">
              <option value="Manual Entry">Manual Entry</option>
              <option value="Phone Call">Phone Call</option>
              <option value="Walk-in">Walk-in</option>
              <option value="Referral Partner">Referral Partner</option>
              <option value="Website Intake">Website Intake</option>
              <option value="Direct Email">Direct Email</option>
              <option value="Google Business">Google Business</option>
              <option value="SMS">SMS</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alUrgency">Urgency</label>
            <select id="alUrgency" name="urgency">
              <option value="MEDIUM" selected>Medium</option>
              <option value="URGENT">Urgent</option>
              <option value="LOW">Low</option>
            </select>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alMatterType">Matter Type</label>
            <select id="alMatterType" name="matterType">
              <option value="">Unknown</option>
              <option value="Family Law">Family Law</option>
              <option value="Care and Protection">Care and Protection</option>
              <option value="Domestic Violence">Domestic Violence</option>
              <option value="Property">Property</option>
              <option value="Criminal">Criminal</option>
              <option value="Estate">Estate</option>
              <option value="Employment">Employment</option>
              <option value="Immigration">Immigration</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="add-lead-field">
            <label class="add-lead-label" for="alLocation">Location / Court Date</label>
            <input id="alLocation" name="location" type="text" placeholder="e.g. Parramatta, 15 May"/>
          </div>
          <div class="add-lead-field span2">
            <label class="add-lead-label" for="alNextAction">Next Action</label>
            <input id="alNextAction" name="nextAction" type="text" placeholder="e.g. Call back, Send retainer"/>
          </div>
          <div class="add-lead-field span2">
            <label class="add-lead-label" for="alNotes">Notes</label>
            <textarea id="alNotes" name="notes" rows="3" placeholder="Key details from the enquiry&#8230;" style="resize:vertical"></textarea>
          </div>
        </div>
        <div class="add-lead-form-actions">
          <button type="button" class="btn btn-secondary" data-close-add-lead>Cancel</button>
          <button type="submit" class="btn btn-primary">Save Lead</button>
        </div>
      </form>
    </div>
  </div>`;

function ensureAddLeadModal() {
  let modal = document.getElementById('addLeadModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', ADD_LEAD_MODAL_HTML);
    modal = document.getElementById('addLeadModal');
  }
  return modal;
}

function openAddLeadModal() {
  const modal = ensureAddLeadModal();
  modal.querySelector('#addLeadForm')?.reset();
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => modal.querySelector('#alName')?.focus(), 60);
}

function closeAddLeadModal() {
  const modal = document.getElementById('addLeadModal');
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
}

function handleAddLeadSubmit(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!String(data.name || '').trim()) { form.querySelector('#alName')?.focus(); return; }
  const lead = addManualLead(data);
  mergeManualLeadsIntoApp();
  app.currentTab = 'new_leads';
  app.heroFilter = 'all';
  closeAddLeadModal();
  updateTabUi();
  updateHeroFilterUi();
  render();
  showNotice(`${lead.sender_name} saved as a manual draft — stored on this device only.`, 'info');
}

let addLeadModalBound = false;
function attachAddLeadModal() {
  if (addLeadModalBound) return;
  const addLeadBtn = document.getElementById('addLeadBtn');
  if (addLeadBtn) addLeadBtn.addEventListener('click', openAddLeadModal);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-add-lead]')) { closeAddLeadModal(); return; }
    const modal = document.getElementById('addLeadModal');
    if (modal && event.target === modal) closeAddLeadModal();
  });
  document.addEventListener('keydown', (event) => {
    const modal = document.getElementById('addLeadModal');
    if (event.key === 'Escape' && modal && !modal.hidden) closeAddLeadModal();
  });
  document.addEventListener('submit', (event) => {
    if (event.target.id === 'addLeadForm') { event.preventDefault(); handleAddLeadSubmit(event.target); }
  });
  addLeadModalBound = true;
}

// ── Config / Supabase ────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    await import(`${CONFIG_PATH}?t=${Date.now()}`);
    app.config = window.LEADS_CONFIG || DEFAULT_CONFIG;
  } catch {
    app.config = DEFAULT_CONFIG;
  }
}

function isSupabaseEnabled() {
  const cfg = app.config?.supabase || {};
  return Boolean(cfg.enabled && cfg.url && cfg.anonKey);
}

async function initSupabase() {
  if (!isSupabaseEnabled()) {
    els.authPanel.hidden = true;
    els.showAuthBtn.hidden = true;
    setDefaultSyncStatus();
    return;
  }
  const { createClient } = await import('./vendor/supabase-js.js');
  app.supabase = createClient(app.config.supabase.url, app.config.supabase.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'leadflow-auth'
    }
  });
  const { data } = await app.supabase.auth.getSession();
  app.session = data.session;
  refreshAuthUi();
  app.supabase.auth.onAuthStateChange((event, session) => {
    // Only clear session on explicit sign-out; INITIAL_SESSION/TOKEN_REFRESHED can
    // fire with null during a refresh cycle and must not wipe a valid stored session.
    if (event === 'SIGNED_OUT') {
      app.session = null;
    } else if (session) {
      app.session = session;
    }
    app.hasLoggedLeadRead = false;
    app.authPanelOpen = false;
    refreshAuthUi();
    if (session) hydrate().catch(handleError);
  });
}

function refreshAuthUi() {
  if (!isSupabaseEnabled()) {
    els.authPanel.hidden = true;
    els.showAuthBtn.hidden = true;
    return;
  }
  const email = app.session?.user?.email;
  els.showAuthBtn.hidden = false;
  if (!email) app.authPanelOpen = true;
  els.showAuthBtn.textContent = email
    ? (app.authPanelOpen ? 'Hide sync settings' : 'Sync settings')
    : (app.authPanelOpen ? 'Hide sign-in' : 'Sign in to load live leads');
  els.authPanel.hidden = !app.authPanelOpen;

  if (email) {
    els.authEmail.hidden = true;
    els.sendMagicLinkBtn.hidden = true;
    els.authStatus.textContent = `Signed in as ${email}`;
  } else {
    els.authEmail.hidden = false;
    els.sendMagicLinkBtn.hidden = false;
    const isPwa = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    els.authStatus.textContent = isPwa
      ? 'This Home Screen version cannot reliably save magic-link login on iPhone. Open LeadFlow in Safari, send the sign-in link there, and keep using the Safari page.'
      : 'Sign in once to sync across phone and laptop. On iPhone, keep using LeadFlow in Safari — not the old Home Screen icon — so the saved login stays available.';
  }
  els.signOutBtn.hidden = !email;
  setDefaultSyncStatus();
}

// ── Lead loading — Supabase-first ────────────────────────────────────────────
async function loadLeads() {
  // When Supabase is configured, all lead data comes from the database.
  // data.json is only used in standalone mode (Supabase disabled in config.js).
  if (isSupabaseEnabled()) {
    if (!app.session) {
      app.leads = [];
      app.lastUpdated = '';
      app.remoteLeadIds = new Set();
      app.hasLoggedLeadRead = false;
      return;
    }
    const { data, error } = await app.supabase
      .from('leads')
      .select('id,source_account,date_received,sender_name,sender_email,sender_phone,subject,source_rule,source_platform,matter_type,priority,status,notes,draft_reply,raw_preview,reviewed_at,location,opposing_party,next_action')
      .order('date_received', { ascending: false });
    if (error) throw new Error(`Supabase leads error: ${error.message}`);
    app.leads = data || [];
    app.lastUpdated = app.leads[0]?.date_received || '';
    app.remoteLeadIds = new Set(app.leads.map((l) => Number(l.id)));
    if (!app.hasLoggedLeadRead) {
      app.hasLoggedLeadRead = true;
      void logSecurityEvent('leads.read_batch', null, { count: app.leads.length });
    }
    return;
  }

  // Standalone mode — Supabase not configured.
  // IMPORTANT: In production, vercel.json blocks data.json with a 404 response,
  // so loadFromFile() will fail and execution falls through to the localStorage import.
  // This is intentional — data.json contains PII and must not be publicly accessible.
  // To load leads in standalone mode, import via the UI (localStorage-backed), or
  // configure Supabase and enable it in config.js.
  const imported = JSON.parse(localStorage.getItem('xena-leads-data-import') || 'null');

  async function loadFromFile() {
    const response = await fetch(`./data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load data.json (${response.status})`);
    const json = await response.json();
    app.leads = Array.isArray(json.leads) ? json.leads : [];
    app.lastUpdated = json.last_updated || '';
  }

  try {
    await loadFromFile();
  } catch {
    if (Array.isArray(imported?.leads) && imported.leads.length) {
      app.leads = imported.leads;
      app.lastUpdated = imported.last_updated || '';
    } else {
      app.leads = [];
      app.lastUpdated = '';
    }
  }
  app.remoteLeadIds = new Set();
}

// ── Inbox — with JWT auth, polling, no demo-data fallback ───────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = INBOX_API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ── AI triage availability probe ─────────────────────────────────────────────
// Called once on hydrate. Uses the GET probe (no auth needed) to check whether
// all three env gates are set on this deployment. The actual triage POST
// requires authentication; the button is hidden when the feature is off.
async function probeAiTriage() {
  try {
    const res = await fetchWithTimeout('/api/ai-triage', {}, 3000);
    if (res.ok) {
      const json = await res.json();
      app.aiTriageAvailable = json.available === true;
    }
  } catch {
    app.aiTriageAvailable = false;
  }
}

async function loadInbox() {
  // Don't poll without a valid session — pre-auth requests cause 401s that wipe inbox
  if (!app.session?.access_token) {
    app.inboxLive = false;
    app.inboxAuthRequired = isSupabaseEnabled();
    app.inboxTransientError = false;
    const storedImported0 = JSON.parse(localStorage.getItem(INBOX_IMPORTED_KEY) || '[]');
    app.inboxImported = new Set(Array.isArray(storedImported0) ? storedImported0.map(String) : []);
    const storedDismissed0 = JSON.parse(localStorage.getItem(INBOX_DISMISSED_KEY) || '[]');
    app.inboxDismissed = new Set(Array.isArray(storedDismissed0) ? storedDismissed0.map(String) : []);
    app.inboxShowDismissed = localStorage.getItem(INBOX_SHOW_DISMISSED_KEY) === '1';
    updateTabCounts();
    updateSummary();
    return;
  }

  try {
    const headers = { 'Authorization': `Bearer ${app.session.access_token}` };
    const response = await fetchWithTimeout(`/api/inbox?t=${Date.now()}`, { cache: 'no-store', headers });
    if (response.ok) {
      const json = await response.json();
      app.inboxAuthRequired = false;
      app.inboxTransientError = false;
      if (json.configured && Array.isArray(json.emails)) {
        app.inbox = json.emails;
        app.inboxAccount = json.inbox_account || json.account || 'Inbox';
        app.inboxAccounts = json.inbox_accounts || [app.inboxAccount];
        app.inboxHiddenCount = typeof json.hidden_count === 'number' ? json.hidden_count : 0;
        app.inboxLive = true;
      } else {
        app.inbox = [];
        app.inboxHiddenCount = 0;
        app.inboxLive = false;
      }
    } else if (response.status === 401 || response.status === 403) {
      // Transient auth failure — preserve last good inbox, will retry on next poll cycle
      app.inboxLive = false;
      app.inboxAuthRequired = true;
      app.inboxTransientError = true;
    } else if (response.status === 429) {
      // Rate limited — preserve last good inbox, will retry on next poll cycle
      app.inboxLive = false;
      app.inboxTransientError = true;
    } else {
      // Other server error — preserve last good inbox and do not show the
      // misleading "not configured" message. The API may be temporarily
      // failing even when Vercel env vars are present.
      app.inboxLive = false;
      app.inboxAuthRequired = isSupabaseEnabled();
      app.inboxTransientError = true;
    }
  } catch {
    // Network/timeout — preserve last good inbox and keep auth/config state.
    app.inboxLive = false;
    app.inboxAuthRequired = isSupabaseEnabled();
    app.inboxTransientError = true;
  }

  // Restore persisted dismiss/import state (use String IDs consistently)
  const storedImported = JSON.parse(localStorage.getItem(INBOX_IMPORTED_KEY) || '[]');
  app.inboxImported = new Set(Array.isArray(storedImported) ? storedImported.map(String) : []);
  const storedDismissed = JSON.parse(localStorage.getItem(INBOX_DISMISSED_KEY) || '[]');
  app.inboxDismissed = new Set(Array.isArray(storedDismissed) ? storedDismissed.map(String) : []);
  app.inboxShowDismissed = localStorage.getItem(INBOX_SHOW_DISMISSED_KEY) === '1';

  // Detect new emails during polling (inboxPrevUnread >= 0 after first load)
  app.inboxLastChecked = new Date();
  const newUnread = app.inbox.filter((e) => (!app.inboxImported.has(String(e.id)) || !inboxEmailHasLeadRecord(e)) && !app.inboxDismissed.has(String(e.id))).length;
  const prevUnread = app.inboxPrevUnread;
  app.inboxPrevUnread = newUnread;
  if (prevUnread >= 0 && app.inboxLive && newUnread > prevUnread) {
    const diff = newUnread - prevUnread;
    showNotice(`${diff} new email${diff !== 1 ? 's' : ''} arrived in the live inbox.`, 'info');
    if (app.currentTab === 'inbox') render();
  }
  // Keep hero tile + tab badge counts fresh even when not re-rendering the lead list
  updateTabCounts();
  updateSummary();
}

function persistInboxImported() {
  localStorage.setItem(INBOX_IMPORTED_KEY, JSON.stringify([...app.inboxImported]));
}

function persistInboxDismissed() {
  localStorage.setItem(INBOX_DISMISSED_KEY, JSON.stringify([...app.inboxDismissed]));
}

function persistInboxShowDismissed() {
  localStorage.setItem(INBOX_SHOW_DISMISSED_KEY, app.inboxShowDismissed ? '1' : '0');
}

function startInboxPolling() {
  if (app.inboxPollTimer) clearInterval(app.inboxPollTimer);
  app.inboxPollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (!app.session?.access_token) return;
    try { await loadInbox(); } catch {}
  }, INBOX_POLL_MS);
}

// ── Inbox rendering ──────────────────────────────────────────────────────────
function inboxAvatarInitials(name) {
  return String(name || '?').split(' ').map((w) => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
}

function renderInboxEmail(email, isDismissed = false) {
  const initials = escapeHtml(inboxAvatarInitials(email.from_name));
  const date = formatDateTime(email.received_at);
  const urgentClass = String(email.priority || '').toUpperCase() === 'URGENT' ? ' inbox-urgent' : '';
  const priorityClass = pillClass(email.priority);
  const priorityVal = String(email.priority || 'Medium');
  const priorityLabel = priorityVal.charAt(0).toUpperCase() + priorityVal.slice(1).toLowerCase();
  const dismissedCardClass = isDismissed ? ' inbox-card-dismissed' : '';
  const sourceMetaPill = isDismissed
    ? '<span class="inbox-meta-pill dismissed-pill">Dismissed locally</span>'
    : `<span class="inbox-meta-pill">${escapeHtml(email.source_label || 'Email')}</span>`;
  const emailIdEsc = escapeHtml(String(email.id));
  const isLoading = app.aiTriageLoading.has(String(email.id));
  const aiTriageBtn = (!isDismissed && app.aiTriageAvailable)
    ? (isLoading
      ? `<button class="btn-ai-triage" type="button" disabled>Analysing\u2026</button>`
      : `<button class="btn-ai-triage" type="button" data-triage-id="${emailIdEsc}">AI Triage</button>`)
    : '';
  const actionButtons = isDismissed
    ? `<button class="btn-import" type="button" data-import-id="${emailIdEsc}">&#x2192; Import as New Lead</button><button class="btn-restore" type="button" data-restore-id="${emailIdEsc}">&#x21BA; Restore</button>`
    : `<button class="btn-import" type="button" data-import-id="${emailIdEsc}">&#x2192; Import as New Lead</button><button class="btn-followup" type="button" data-followup-import-id="${emailIdEsc}">Add to Follow-up</button><button class="btn-existing" type="button" data-existing-import-id="${emailIdEsc}">Existing matter</button><button class="btn-dismiss" type="button" data-dismiss-id="${emailIdEsc}">Dismiss</button>${aiTriageBtn}`;

  const draft = app.aiTriageDrafts[String(email.id)];
  const MATTER_LABELS = { family_law: 'Family Law', property: 'Property', criminal: 'Criminal', estate: 'Estate', employment: 'Employment', immigration: 'Immigration', other: 'Other', unclear: 'Unclear' };
  const draftPanel = draft
    ? `<div class="ai-triage-panel">
        <div class="ai-triage-warning">AI triage hint \u2014 practitioner review required before acting on this.</div>
        <div class="ai-triage-fields">
          <span class="ai-triage-field">Matter: <strong>${escapeHtml(MATTER_LABELS[draft.matter_type_guess] || draft.matter_type_guess)}</strong></span>
          <span class="ai-triage-field">Urgency: <strong>${escapeHtml(draft.urgency_guess)}</strong></span>
          ${draft.location_mentioned ? `<span class="ai-triage-field">Location: <strong>${escapeHtml(draft.location_mentioned)}</strong></span>` : ''}
        </div>
        <div class="ai-triage-review-note">${escapeHtml(draft.human_review_warning)}</div>
        <button class="btn-clear-triage" type="button" data-clear-triage="${emailIdEsc}">Clear draft</button>
      </div>`
    : '';

  return `<div class="inbox-card${urgentClass}${dismissedCardClass}">
    <div class="inbox-from">
      <div class="inbox-avatar">${initials}</div>
      <div class="inbox-from-details">
        <div class="inbox-from-name">${escapeHtml(email.from_name)}</div>
        <div class="inbox-from-addr">${escapeHtml(email.from_email)} &#x2192; ${escapeHtml(email.source_account || app.inboxAccount || 'Inbox')}</div>
      </div>
      <div class="pill ${escapeHtml(priorityClass)} priority-pill">${escapeHtml(priorityLabel)}</div>
    </div>
    <div class="inbox-subject">${escapeHtml(email.subject)}</div>
    <div class="inbox-snippet">${escapeHtml(email.snippet)}</div>
    <div class="inbox-meta">
      <span>${escapeHtml(date)}</span>
      <span class="inbox-meta-pill">${escapeHtml(email.matter_type || 'General')}</span>
      <span class="inbox-meta-pill">${escapeHtml(email.location || 'NSW')}</span>
      ${sourceMetaPill}
    </div>
    <div class="actions">
      ${actionButtons}
    </div>
    ${draftPanel}
  </div>`;
}

function renderInbox() {
  if (!app.inboxLive && !app.inbox.length) {
    let msg;
    if (app.inboxTransientError) {
      msg = app.session?.user?.email
        ? `Inbox temporarily unavailable for ${escapeHtml(app.session.user.email)}. The tracker is signed in and will retry automatically. Tap Update tracker now, or reopen in Safari if this persists.`
        : 'Inbox temporarily unavailable — your session may be refreshing. Will retry automatically.';
    } else if (app.inboxAuthRequired || isSupabaseEnabled()) {
      msg = app.session?.user?.email
        ? `Signed in as ${escapeHtml(app.session.user.email)}. Inbox is loading — tap Update tracker now if it does not refresh.`
        : 'Sign in to access the live inbox.';
    } else {
      msg = 'Inbox not configured. Set JGMS_EMAIL + Azure credentials, FLA_EMAIL + FLA_IMAP_PASSWORD, or NTRRLS_EMAIL + NTRRLS_IMAP_PASSWORD in Vercel environment variables to enable live inbox.';
    }
    els.list.innerHTML = `<div class="inbox-empty">${msg}</div>`;
    els.emptyState.hidden = true;
    return;
  }
  const pending = app.inbox.filter((e) => (!app.inboxImported.has(String(e.id)) || !inboxEmailHasLeadRecord(e)) && !app.inboxDismissed.has(String(e.id)));
  const dismissed = app.inbox.filter((e) => (!app.inboxImported.has(String(e.id)) || !inboxEmailHasLeadRecord(e)) && app.inboxDismissed.has(String(e.id)));

  const accounts = (app.inboxAccounts && app.inboxAccounts.length) ? app.inboxAccounts : [app.inboxAccount || 'Inbox'];
  const accountLabel = accounts.join(', ');

  const staleBanner = (!app.inboxLive && app.inboxTransientError)
    ? '<div class="inbox-stale-note">Inbox temporarily unavailable \u2014 showing last loaded messages. Retrying automatically.</div>'
    : '';
  const hiddenNote = app.inboxHiddenCount > 0
    ? ` &mdash; <span title="System notifications, deployment alerts and auth emails are excluded automatically.">${app.inboxHiddenCount} system email${app.inboxHiddenCount !== 1 ? 's' : ''} filtered</span>`
    : '';
  let html = staleBanner + `<div class="inbox-header">Live inbox (likely leads and follow-up replies) &mdash; <strong>${escapeHtml(accountLabel)}</strong> &mdash; ${pending.length} message${pending.length !== 1 ? 's' : ''}${hiddenNote}. Use <em>Import as New Lead</em>, <em>Add to Follow-up</em>, or <em>Existing matter</em>. <em>Dismiss</em> hides here only &mdash; email stays in your mailbox.</div>`;

  if (pending.length) {
    html += pending.map((e) => renderInboxEmail(e, false)).join('');
  } else {
    html += '<div class="inbox-empty">No new messages in the inbox. Dismissed emails are hidden in this browser only — the original email is untouched in your mailbox.</div>';
  }

  if (dismissed.length) {
    const toggleLabel = app.inboxShowDismissed ? `Hide dismissed (${dismissed.length})` : `Show dismissed (${dismissed.length})`;
    html += `<button class="btn-toggle-dismissed" type="button" data-toggle-dismissed>${escapeHtml(toggleLabel)}</button>`;
    if (app.inboxShowDismissed) {
      html += '<div class="dismissed-section">' +
        dismissed.map((e) => renderInboxEmail(e, true)).join('') +
        '</div>';
    }
  }

  els.list.innerHTML = html;
  els.emptyState.hidden = true;
}

// ── Inbox actions (with security event logging) ───────────────────────────────
function buildLeadFromInboxEmail(email, status = 'new') {
  return {
    id: String(email.id || `inbox-${Date.now()}`),
    sender_name: email.from_name,
    sender_email: email.from_email,
    sender_phone: email.phone || 'Unknown',
    subject: email.subject,
    date_received: email.received_at,
    source_account: email.source_account || 'Direct Email',
    source_platform: 'Email',
    source_rule: `Live inbox (${email.source_account || app.inboxAccount || 'Inbox'}) - ${email.source_label || 'Email'}`,
    matter_type: email.matter_type || 'Unknown',
    priority: email.priority || 'MEDIUM',
    status,
    notes: '',
    raw_preview: email.snippet || '',
    next_action: email.next_action || (status === 'follow_up' ? 'Follow up with prospective/existing matter' : 'Reply to email'),
    location: email.location || 'Unknown',
    opposing_party: email.opposing_party || 'Unknown',
    _isManualDraft: true
  };
}

function persistInboxLeadLocally(lead) {
  const manual = loadManualLeads().filter((l) => String(l.id) !== String(lead.id));
  manual.unshift({ ...lead, _isManualDraft: undefined });
  saveManualLeads(manual);
  mergeManualLeadsIntoApp();
}

function importInboxEmailWithStage(emailId, stage = 'new_lead') {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email) return;
  const sourceMeta = getSourceMeta(email.source_account || app.inboxAccount || 'Inbox');
  void logSecurityEvent('inbox.import', String(email.id), {
    source: sourceMeta.key,
    from_domain: getEmailDomain(email.from_email),
    has_phone: Boolean(email.phone),
    stage
  });
  const lead = buildLeadFromInboxEmail(email, stage === 'follow_up' ? 'follow_up' : 'new');
  persistInboxLeadLocally(lead);
  app.inboxImported.add(String(email.id));
  app.inboxDismissed.delete(String(email.id));
  persistInboxImported();
  persistInboxDismissed();
  const patch = {};
  if (stage === 'follow_up') patch.prospectiveStatus = 'contacted';
  if (stage === 'existing_matter') {
    patch.prospectiveStatus = 'existing_matter';
    patch.actioned = true;
    patch.noAction = true;
  }
  if (Object.keys(patch).length) setLeadState(lead.id, patch);
  app.currentTab = stage === 'new_lead' ? 'new_leads' : (stage === 'follow_up' ? 'followup' : 'closed');
  app.heroFilter = 'all';
  updateTabUi();
  updateHeroFilterUi();
  render();
  const label = stage === 'follow_up' ? 'Follow-up' : (stage === 'existing_matter' ? 'Closed / Existing matter' : 'New Leads');
  showNotice(`${email.from_name} added to ${label}.`, 'info');
}

function importInboxEmail(emailId) {
  importInboxEmailWithStage(emailId, 'new_lead');
}

function importInboxEmailAsFollowUp(emailId) {
  importInboxEmailWithStage(emailId, 'follow_up');
}

function importInboxEmailAsExistingMatter(emailId) {
  importInboxEmailWithStage(emailId, 'existing_matter');
}

function dismissInboxEmail(emailId) {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email) return;
  const sourceMeta = getSourceMeta(email.source_account || app.inboxAccount || 'Inbox');
  void logSecurityEvent('inbox.dismiss', String(email.id), { source: sourceMeta.key });
  app.inboxDismissed.add(String(email.id));
  persistInboxDismissed();
  renderInbox();
  updateTabCounts();
  updateSummary();
}

function undismissInboxEmail(emailId) {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email) return;
  const sourceMeta = getSourceMeta(email.source_account || app.inboxAccount || 'Inbox');
  void logSecurityEvent('inbox.undismiss', String(email.id), { source: sourceMeta.key });
  app.inboxDismissed.delete(String(email.id));
  persistInboxDismissed();
  renderInbox();
  updateTabCounts();
  updateSummary();
}

function toggleInboxShowDismissed() {
  app.inboxShowDismissed = !app.inboxShowDismissed;
  persistInboxShowDismissed();
  renderInbox();
}

// ── AI triage actions ─────────────────────────────────────────────────────────
async function triageInboxEmail(emailId) {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email || !app.session?.access_token) return;

  // Show loading state
  app.aiTriageLoading.add(String(emailId));
  renderInbox();

  try {
    const res = await fetchWithTimeout('/api/ai-triage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${app.session.access_token}`,
      },
      body: JSON.stringify({
        email_id: String(email.id),
        subject: email.subject || '',
        snippet: email.snippet || '',
        source_label: email.source_label || '',
      }),
    }, 12000);

    const json = await res.json().catch(() => null);

    if (res.ok && json?.ok && json?.extraction) {
      app.aiTriageDrafts[String(emailId)] = json.extraction;
      void logSecurityEvent('inbox.ai_triage_complete', String(email.id), {
        source: getSourceMeta(email.source_account || '').key,
        matter_type: json.extraction.matter_type_guess,
        urgency: json.extraction.urgency_guess,
      });
    } else if (res.status === 422) {
      showNotice('AI triage blocked: this email contains patterns that prevent processing.', 'error');
    } else if (res.status === 503) {
      showNotice('AI triage is not configured on this deployment.', 'info');
      app.aiTriageAvailable = false;
    } else {
      const msg = json?.error || 'AI extraction failed. Try again later.';
      showNotice(msg, 'error');
    }
  } catch {
    showNotice('AI triage request timed out. Try again.', 'error');
  } finally {
    app.aiTriageLoading.delete(String(emailId));
    renderInbox();
  }
}

function clearAiTriage(emailId) {
  delete app.aiTriageDrafts[String(emailId)];
  renderInbox();
}


function isMissingLeadStateExtendedColumn(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    /column .* does not exist/i.test(String(error?.message || error || '')) ||
    (message.includes('could not find') && message.includes('lead_states') && (message.includes('prospective_status') || message.includes('follow_up_date'))) ||
    (message.includes('schema cache') && (message.includes('prospective_status') || message.includes('follow_up_date')))
  );
}

// ── Supabase state sync ──────────────────────────────────────────────────────
async function loadSupabaseState() {
  if (!(app.supabase && app.session)) return;
  const { data, error } = await app.supabase.from('lead_states').select('*');
  if (error) throw error;
  const next = {};
  for (const row of data || []) {
    next[String(row.lead_id)] = {
      actioned: Boolean(row.actioned),
      leap: Boolean(row.leap),
      noAction: Boolean(row.no_action),
      laAccepted: Boolean(row.la_accepted),
      comment: row.comment || '',
      prospectiveStatus: row.prospective_status || '',
      followUpDate: row.follow_up_date || '',
    };
  }
  app.state = { ...app.state, ...next };
  persistLocalState();
}

async function saveStateRemote(leadId) {
  if (!(app.supabase && app.session)) return;
  if (!app.remoteLeadIds.has(Number(leadId))) return;
  const state = getLeadState(leadId);
  setSyncStatus('Syncing…');
  const payload = {
    lead_id: Number(leadId),
    user_id: app.session.user.id,
    actioned: state.actioned,
    leap: state.leap,
    no_action: state.noAction,
    la_accepted: state.laAccepted,
    comment: state.comment,
    prospective_status: state.prospectiveStatus || null,
    follow_up_date: state.followUpDate || null,
  };
  let { error } = await app.supabase.from('lead_states').upsert(payload, { onConflict: 'user_id,lead_id' });
  if (error && isMissingLeadStateExtendedColumn(error)) {
    // Migration not yet applied — retry without the new columns.
    // Supabase may report this as either “column does not exist” or
    // “could not find ... in schema cache”. Either way, keep the app usable.
    delete payload.prospective_status;
    delete payload.follow_up_date;
    ({ error } = await app.supabase.from('lead_states').upsert(payload, { onConflict: 'user_id,lead_id' }));
    console.warn('LeadFlow follow-up migration not applied yet — saved without new fields');
  }
  if (error) throw error;
  setSyncStatus('Synced');
}

async function syncAllMeaningfulStateRemote() {
  if (!(app.supabase && app.session)) return;
  const entries = Object.entries(app.state).filter(([leadId, state]) => hasMeaningfulState(state) && app.remoteLeadIds.has(Number(leadId)));
  if (!entries.length) {
    setSyncStatus('Synced');
    return;
  }
  setSyncStatus('Syncing…');
  let migrationWarned = false;
  for (const [leadId, state] of entries) {
    const payload = {
      lead_id: Number(leadId),
      user_id: app.session.user.id,
      actioned: Boolean(state.actioned),
      leap: Boolean(state.leap),
      no_action: Boolean(state.noAction),
      la_accepted: Boolean(state.laAccepted),
      comment: state.comment || '',
      prospective_status: state.prospectiveStatus || null,
      follow_up_date: state.followUpDate || null,
    };
    let { error } = await app.supabase.from('lead_states').upsert(payload, { onConflict: 'user_id,lead_id' });
    if (error && isMissingLeadStateExtendedColumn(error)) {
      if (!migrationWarned) {
        console.warn('LeadFlow follow-up migration not applied yet — syncing without new fields');
        migrationWarned = true;
      }
      delete payload.prospective_status;
      delete payload.follow_up_date;
      ({ error } = await app.supabase.from('lead_states').upsert(payload, { onConflict: 'user_id,lead_id' }));
    }
    if (error) throw error;
  }
  setSyncStatus('Synced');
}

// ── Lead display helpers ─────────────────────────────────────────────────────
function leadUrgencyClass(priority) {
  const value = String(priority || '').toUpperCase();
  if (value === 'URGENT') return 'urgent-row';
  if (value === 'MEDIUM') return 'medium-row';
  return 'low-row';
}

function pillClass(priority) {
  const value = String(priority || '').toUpperCase();
  if (value === 'URGENT') return 'urgent';
  if (value === 'MEDIUM') return 'medium';
  return 'low';
}

function sourcePillClass(source) {
  return getSourceMeta(source).className;
}

function inferType(lead) {
  const matter = String(lead.matter_type || '');
  if (/care|child/i.test(matter)) return 'Care and Protection';
  if (/violence/i.test(matter)) return 'Domestic Violence';
  if (/family/i.test(matter)) return 'Family Law';
  return matter || 'Other';
}

function getSlaRiskHours(priority) {
  const value = String(priority || '').trim().toUpperCase();
  if (value === 'URGENT') return 1;
  if (value === 'MEDIUM') return 4;
  return 24;
}

function isLeadAtSlaRisk(lead) {
  const leadDate = parseLeadDate(lead?.date_received);
  if (!leadDate) return false;
  const elapsedHours = (Date.now() - leadDate.getTime()) / 3600000;
  return elapsedHours > getSlaRiskHours(lead?.priority);
}

// ── Lead rendering — accordion with compact header ───────────────────────────
function renderLead(lead, index) {
  const id = getLeadId(lead, index);
  const state = getLeadState(id);
  const source = getLeadSourceValue(lead);
  const sourceMeta = getSourceMeta(source);
  const sourceLabel = sourceMeta.label;
  const phone = lead.sender_phone || lead.phone || (sourceMeta.key === 'sms' ? 'Check SMS app' : 'Unknown');
  const email = lead.sender_email || 'Unknown';
  const summary = lead.raw_preview || lead.notes || '';
  const date = formatLeadDate(lead.date_received);
  const leadDate = parseLeadDate(lead.date_received);
  const ago = leadDate ? timeAgo(leadDate) : '';
  const diffDays = leadDate ? Math.floor((Date.now() - leadDate.getTime()) / 86400000) : -1;
  const agoClass = `time-since${diffDays >= 0 && diffDays <= 7 ? ' time-since-fresh' : diffDays > 30 ? ' time-since-old' : ''}`;
  const agoBadge = ago ? `<span class="${agoClass}">${escapeHtml(ago)}</span>` : '';
  const manualBadge = lead._isManualDraft ? '<span class="manual-draft-badge">Manual draft &middot; device only</span>' : '';
  const prospectPriority = getFollowUpPriority(lead, state);
  const statusBadgeClass = getStatusBadgeClass(state.prospectiveStatus);
  const statusBadge = state.prospectiveStatus
    ? `<span class="${escapeHtml(statusBadgeClass)}">${escapeHtml(getProspectStatusLabel(state.prospectiveStatus))}</span>`
    : '';
  const staleBadge = prospectPriority?.bucket === 'stale'
    ? `<span class="stale-indicator">${escapeHtml(prospectPriority.label)}</span>`
    : '';
  const rowClass = `${leadUrgencyClass(lead.priority)} ${state.actioned ? 'actioned-row' : ''}`.trim();
  const typeLabel = inferType(lead);
  const subject = lead.subject || '';
  const location = lead.location || 'Unknown';
  const opposing = lead.opposing_party || 'Unknown';
  const nextAction = lead.next_action || (state.actioned ? 'Completed' : 'Follow up');
  const priorityValue = String(lead.priority || 'LOW').toUpperCase();
  const priorityLabel = priorityValue.charAt(0) + priorityValue.slice(1).toLowerCase();
  const hasPhone = phone && phone !== 'Unknown' && phone !== 'Check SMS app';
  const hasEmail = email !== 'Unknown';
  const showSideCall = priorityValue === 'URGENT' && hasPhone;

  // Expanded call shows desktop modal; mobile goes direct to tel:
  const callBtn = hasPhone
    ? `<button class="btn-call" type="button" data-call-phone="${escapeHtml(phone)}" data-call-name="${escapeHtml(lead.sender_name || 'Lead')}" data-call-id="${escapeHtml(id)}">&#128222; Call</button>`
    : '';
  const smsDraftBtn = hasPhone
    ? `<button class="btn-sms" type="button" data-draft-sms="${escapeHtml(id)}">&#128172; SMS</button>`
    : '';
  const emailDraftBtn = hasEmail
    ? `<button class="btn-email" type="button" data-draft-email="${escapeHtml(id)}">&#9993;&#65039; Email</button>`
    : '';
  const deleteBtn = `<button class="btn btn-danger" type="button" data-delete-id="${escapeHtml(id)}">Delete lead</button>`;

  const secondaryActions = `${smsDraftBtn}${emailDraftBtn}${deleteBtn}`;
  const actionMarkup = callBtn
    ? `<div class="actions-wrap"><div class="call-primary-row">${callBtn}</div><div class="actions">${secondaryActions}</div></div>`
    : `<div class="actions">${secondaryActions}</div>`;

  const sideMarkup = showSideCall
    ? `<button class="lead-side lead-side-call quick-call-btn quick-call-pulse" type="button" data-call-phone="${escapeHtml(phone)}" data-call-name="${escapeHtml(lead.sender_name || 'Lead')}" data-call-id="${escapeHtml(id)}" aria-label="Call ${escapeHtml(lead.sender_name || 'lead')}"><span class="call-icon">&#128222;</span></button>`
    : `<div class="lead-side lead-side-chevron"><span class="lead-chevron" aria-hidden="true">&#8250;</span></div>`;

  const pipelineTab = getPipelineTab(lead, state);
  const stageActionsMarkup = renderStageActions(pipelineTab, id);
  const isExpanded = app.expandedLeads.has(id);
  const prospectSelectClass = [
    'prospect-status-select',
    state.prospectiveStatus === 'ready_for_leap' ? 'status-ready-leap' : '',
    prospectPriority?.bucket === 'stale' ? 'status-stale' : '',
  ].filter(Boolean).join(' ');
  const followUpDateNote = state.followUpDate
    ? `<span class="time-since">${escapeHtml(formatDateOnly(state.followUpDate))}</span>`
    : '<span class="time-since">No due date</span>';
  const nextActionReview = lead.next_action
    ? `<div class="field"><strong>Review Next</strong>${escapeHtml(lead.next_action)}</div>`
    : '';
  const trackerStatusReview = lead.status
    ? `<div class="field"><strong>Imported Status</strong>${escapeHtml(lead.status)}</div>`
    : '';
  const reviewMetaGrid = (nextActionReview || trackerStatusReview)
    ? `<div class="grid">${nextActionReview}${trackerStatusReview}</div>`
    : '';

  return `<div class="row ${rowClass}${isExpanded ? ' expanded' : ''}" data-id="${escapeHtml(id)}" data-source="${escapeHtml(sourceMeta.key)}" data-date="${escapeHtml(lead.date_received || date)}" data-urgency="${escapeHtml(priorityValue)}">
    <div class="lead-header" role="button" aria-expanded="${isExpanded}" tabindex="0">
      <div class="lead-main">
        <div class="lead-main-top">
          <div class="lead-heading">
            <div class="name">${escapeHtml(lead.sender_name || 'Unknown')}</div>
          </div>
          <div class="pill ${pillClass(lead.priority)} priority-pill">${escapeHtml(priorityLabel)}</div>
        </div>
        <div class="meta">${agoBadge}<span>${escapeHtml(date)}</span><span class="meta-sep">•</span><span>${escapeHtml(sourceLabel)}</span>${manualBadge}${statusBadge}${staleBadge}</div>
      </div>
      ${sideMarkup}
    </div>
    <div class="lead-body"${isExpanded ? '' : ' hidden'}>
      <div class="pill-row"><span class="pill ${escapeHtml(sourcePillClass(source))}">${escapeHtml(sourceLabel)}</span><span class="pill type-pill">${escapeHtml(typeLabel)}</span></div>
      <div class="grid">
        <div class="field"><strong>Matter Type</strong>${escapeHtml(lead.matter_type || 'Unknown')}</div>
        <div class="field"><strong>Location</strong>${escapeHtml(location)}</div>
        <div class="field"><strong>Opposing Party</strong>${escapeHtml(opposing)}</div>
        <div class="field"><strong>Next Action</strong>${escapeHtml(nextAction)}</div>
      </div>
      ${reviewMetaGrid}
      <div class="grid">
        <div class="field"><strong>Email</strong>${hasEmail ? `<a class="contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '<span class="unknown">Unknown</span>'}</div>
        <div class="field"><strong>Phone</strong>${hasPhone ? `<a class="contact-link" href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : `<span class="unknown">${escapeHtml(phone || 'Unknown')}</span>`}</div>
      </div>
      ${actionMarkup}
      ${stageActionsMarkup}
      <div class="field summary-field"><strong>Summary</strong>${escapeHtml(summary)}</div>
      <div class="prospect-status-wrap">
        <span class="prospect-status-label">Review stage</span>
        <select class="${escapeHtml(prospectSelectClass)}" data-prospect-status-id="${escapeHtml(id)}" aria-label="Prospective client review stage">
          ${PROSPECT_STATUSES.map((status) => `<option value="${escapeHtml(status.value)}"${status.value === state.prospectiveStatus ? ' selected' : ''}>${escapeHtml(status.label)}</option>`).join('')}
        </select>
        <input type="date" value="${escapeHtml(state.followUpDate || '')}" data-followup-date-id="${escapeHtml(id)}" aria-label="Follow-up due date">
        ${followUpDateNote}
      </div>
      <div class="leap-row">
        <div class="leap-item actioned-item"><input type="checkbox" data-flag="actioned" data-id="${escapeHtml(id)}" ${state.actioned ? 'checked' : ''}><label>&#x2705; Actioned</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="leap" data-id="${escapeHtml(id)}" ${state.leap ? 'checked' : ''}><label>LEAP Client</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="noAction" data-id="${escapeHtml(id)}" ${state.noAction ? 'checked' : ''}><label>No Action</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="laAccepted" data-id="${escapeHtml(id)}" ${state.laAccepted ? 'checked' : ''}><label>LA</label></div>
      </div>
      <div class="comment-wrap"><strong>Internal review notes</strong><textarea class="comment-box" data-comment-id="${escapeHtml(id)}" placeholder="Review first. Record call attempts, missing documents, Legal Aid notes, or why no reply was closed.">${escapeHtml(state.comment || '')}</textarea></div>
    </div>
  </div>`;
}

function renderFollowUpInboxCard(email) {
  const date = formatDateTime(email.received_at);
  const sourceMeta = getSourceMeta(email.source_account || 'Inbox');
  return `<div class="fu-inbox-card" data-source="${escapeHtml(sourceMeta.key)}" data-date="${escapeHtml(email.received_at || '')}" data-urgency="">
    <div class="fu-inbox-from">${escapeHtml(email.from_name || 'Unknown sender')}</div>
    <div class="fu-inbox-addr">${escapeHtml(email.from_email || 'Unknown email')} &middot; ${escapeHtml(date)}</div>
    <div class="fu-inbox-subject">${escapeHtml(email.subject || '(no subject)')}</div>
    <div class="fu-inbox-snippet">${escapeHtml(email.snippet || '')}</div>
    <div class="fu-inbox-actions">
      <button class="btn-followup" type="button" data-followup-import-id="${escapeHtml(String(email.id))}">Add to Follow-up</button>
      <button class="btn-existing" type="button" data-existing-import-id="${escapeHtml(String(email.id))}">Existing matter</button>
      <button class="btn-dismiss" type="button" data-dismiss-id="${escapeHtml(String(email.id))}">Dismiss</button>
    </div>
  </div>`;
}


function isLeadAtRiskForPipeline(lead, state) {
  if (getPipelineTab(lead, state) === 'closed') return false;
  if (isLeadAtSlaRisk(lead)) return true;
  const priorityBucket = getFollowUpPriority(lead, state)?.bucket || '';
  return ['due', 'stale', 'ready'].includes(priorityBucket);
}

function renderHeroFilteredLeads() {
  const visibleLeads = getVisibleLeads();
  let title = '';
  let leads = [];
  if (app.heroFilter === 'urgent') {
    title = 'Urgent work across LeadFlow';
    leads = visibleLeads.filter((lead) => {
      const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
      return getPipelineTab(lead, state) !== 'closed' && String(lead.priority || '').toUpperCase() === 'URGENT';
    });
  } else if (app.heroFilter === 'stale') {
    title = 'At-risk work across LeadFlow';
    leads = visibleLeads.filter((lead) => {
      const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
      return isLeadAtRiskForPipeline(lead, state);
    });
  } else {
    return false;
  }
  if (!leads.length) {
    els.list.innerHTML = `<div class="pipeline-onboard"><strong>No ${escapeHtml(app.heroFilter === 'urgent' ? 'urgent' : 'at-risk')} items found</strong><p>The summary tile may include recently changed items, browser state, or items now moved into another stage. Clear the shortcut and check Follow-up, Ready to Open and Inbox.</p></div>`;
  } else {
    els.list.innerHTML = renderPipelineSection(title, leads, 'Nothing to show.');
  }
  els.emptyState.hidden = true;
  return true;
}

function renderPipelineSection(title, leads, emptyText = 'Nothing here right now.') {
  return `<section class="pipeline-section">
    <div class="pipeline-section-header">${escapeHtml(title)} <span class="pipeline-section-count">${leads.length}</span></div>
    ${leads.length ? leads.map((lead) => renderLead(lead, app.leads.indexOf(lead))).join('') : `<div class="fu-empty">${escapeHtml(emptyText)}</div>`}
  </section>`;
}

function renderNewLeadsTab() {
  const visibleLeads = getVisibleLeads();
  const newLeads = visibleLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return getPipelineTab(lead, state) === 'new_leads';
  });
  if (!newLeads.length) {
    els.list.innerHTML = `<div class="pipeline-onboard"><strong>No new leads</strong><p>New leads from email, SMS, and portal enquiries appear here. Import from Inbox or add manually. Once you contact a lead, mark them as Contacted to move to Follow-up.</p></div>`;
    els.emptyState.hidden = true;
    return;
  }
  els.list.innerHTML = newLeads.map((lead) => renderLead(lead, app.leads.indexOf(lead))).join('');
  els.emptyState.hidden = true;
}

function renderFollowUpTab() {
  const visibleLeads = getVisibleLeads();
  const followupLeads = visibleLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return getPipelineTab(lead, state) === 'followup';
  });
  const unmatchedReplies = getUnmatchedFollowUpInboxItems();

  if (!followupLeads.length && !unmatchedReplies.length) {
    els.list.innerHTML = `<div class="pipeline-onboard"><strong>Follow-up queue is clear</strong><p>Leads move here once you mark them as Contacted. Update each lead&#8217;s status (Awaiting reply, Awaiting documents, Awaiting Legal Aid) and advance them to Ready to Open Matter when the time comes.</p></div>`;
    els.emptyState.hidden = true;
    return;
  }

  const byStatus = { awaiting_reply: [], awaiting_documents: [], awaiting_legal_aid: [], contacted: [] };
  for (const lead of followupLeads) {
    const s = getLeadState(getLeadId(lead, app.leads.indexOf(lead))).prospectiveStatus;
    if (s === 'awaiting_reply') byStatus.awaiting_reply.push(lead);
    else if (s === 'awaiting_documents') byStatus.awaiting_documents.push(lead);
    else if (s === 'awaiting_legal_aid') byStatus.awaiting_legal_aid.push(lead);
    else byStatus.contacted.push(lead);
  }

  let html = '';
  if (byStatus.contacted.length) html += renderPipelineSection('Contacted \u2014 awaiting sub-status', byStatus.contacted, 'No leads here.');
  if (byStatus.awaiting_reply.length) html += renderPipelineSection('Awaiting reply', byStatus.awaiting_reply, 'No leads here.');
  if (byStatus.awaiting_documents.length) html += renderPipelineSection('Awaiting documents', byStatus.awaiting_documents, 'No leads here.');
  if (byStatus.awaiting_legal_aid.length) html += renderPipelineSection('Awaiting Legal Aid', byStatus.awaiting_legal_aid, 'No leads here.');

  if (unmatchedReplies.length) {
    html += `<section class="pipeline-section">
      <div class="pipeline-section-header">Unmatched inbox replies <span class="pipeline-section-count">${unmatchedReplies.length}</span></div>
      <div class="fu-review-notice">These inbox messages look like follow-up replies but don&#8217;t match an existing lead. Import or dismiss each one.</div>
      ${unmatchedReplies.map(renderFollowUpInboxCard).join('')}
    </section>`;
  }

  els.list.innerHTML = html || `<div class="fu-empty">Nothing to show.</div>`;
  els.emptyState.hidden = true;
}

function renderReadyTab() {
  const visibleLeads = getVisibleLeads();
  const readyLeads = visibleLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return getPipelineTab(lead, state) === 'ready';
  });
  if (!readyLeads.length) {
    els.list.innerHTML = `<div class="pipeline-onboard"><strong>Ready to Open Matter — handoff list is clear</strong><p>Leads appear here when you mark them as Ready to Open Matter. Open each matter in LEAP, then mark Opened in LEAP to close the loop.</p></div>`;
    els.emptyState.hidden = true;
    return;
  }
  els.list.innerHTML = renderPipelineSection('Ready to Open Matter', readyLeads, 'Nothing marked ready yet.');
  els.emptyState.hidden = true;
}

function renderClosedTab() {
  const visibleLeads = getVisibleLeads();
  const closedLeads = visibleLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return getPipelineTab(lead, state) === 'closed';
  });
  if (!closedLeads.length) {
    els.list.innerHTML = `<div class="pipeline-onboard"><strong>Nothing closed yet</strong><p>Declined leads, no-response closures, existing matters, and leads opened in LEAP are archived here.</p></div>`;
    els.emptyState.hidden = true;
    return;
  }

  const byReason = { opened_in_leap: [], existing_matter: [], not_a_lead: [], declined: [], closed_no_response: [], other: [] };
  for (const lead of closedLeads) {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    if (state.prospectiveStatus === 'opened_in_leap' || (state.actioned && state.leap)) byReason.opened_in_leap.push(lead);
    else if (state.prospectiveStatus === 'existing_matter') byReason.existing_matter.push(lead);
    else if (state.prospectiveStatus === 'not_a_lead') byReason.not_a_lead.push(lead);
    else if (state.prospectiveStatus === 'declined' || state.noAction) byReason.declined.push(lead);
    else if (state.prospectiveStatus === 'closed_no_response') byReason.closed_no_response.push(lead);
    else byReason.other.push(lead);
  }

  let html = '';
  if (byReason.opened_in_leap.length) html += renderPipelineSection('Opened in LEAP', byReason.opened_in_leap);
  if (byReason.existing_matter.length) html += renderPipelineSection('Existing matter — not a new lead', byReason.existing_matter);
  if (byReason.not_a_lead.length) html += renderPipelineSection('Not a lead', byReason.not_a_lead);
  if (byReason.declined.length) html += renderPipelineSection('Declined / No capacity', byReason.declined);
  if (byReason.closed_no_response.length) html += renderPipelineSection('Closed \u2014 no response', byReason.closed_no_response);
  if (byReason.other.length) html += renderPipelineSection('Other closed', byReason.other);

  els.list.innerHTML = html;
  els.emptyState.hidden = true;
}

// ── Summary / hero stats ─────────────────────────────────────────────────────
function updateSummary() {
  const visibleLeads = getVisibleLeads();
  const activeLeads = visibleLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return getPipelineTab(lead, state) !== 'closed';
  });
  const urgentCount = activeLeads.filter((lead) => String(lead.priority || '').toUpperCase() === 'URGENT').length;
  const agingCount = activeLeads.filter((lead) => {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    return isLeadAtRiskForPipeline(lead, state);
  }).length;
  const unread = app.inbox.filter((e) => (!app.inboxImported.has(String(e.id)) || !inboxEmailHasLeadRecord(e)) && !app.inboxDismissed.has(String(e.id))).length;

  if (els.heroStatUrgent) els.heroStatUrgent.textContent = String(urgentCount);
  if (els.heroStatAging) els.heroStatAging.textContent = String(agingCount);
  if (els.heroStatNew) els.heroStatNew.textContent = String(unread);

  if (app.inboxLastChecked) {
    const syncTime = app.inboxLastChecked.toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    els.lastUpdatedLine.textContent = `Last sync ${syncTime}`;
  } else if (app.lastUpdated) {
    els.lastUpdatedLine.textContent = `Last sync ${formatDateTime(app.lastUpdated)}`;
  } else {
    els.lastUpdatedLine.textContent = 'Last sync: checking…';
  }
  if (els.updateNowLink) els.updateNowLink.href = `./?update=${Date.now()}`;
}

function updateSourceFilter() {
  const visibleLeads = getVisibleLeads();
  const sources = Array.from(new Map(
    visibleLeads.map((lead) => {
      const meta = getSourceMeta(getLeadSourceValue(lead));
      return [meta.key, meta.label];
    })
  ).entries());
  const current = els.sourceFilter.value || 'all';
  els.sourceFilter.innerHTML = '<option value="all">All sources</option>' +
    sources.map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('');
  els.sourceFilter.value = sources.some(([key]) => key === current) ? current : 'all';
}

function updateTabCounts() {
  const visibleLeads = getVisibleLeads();
  const counts = { new_leads: 0, followup: 0, ready: 0, closed: 0 };
  for (const lead of visibleLeads) {
    const state = getLeadState(getLeadId(lead, app.leads.indexOf(lead)));
    const tab = getPipelineTab(lead, state);
    counts[tab] = (counts[tab] || 0) + 1;
  }
  const unread = app.inbox.filter((e) => (!app.inboxImported.has(String(e.id)) || !inboxEmailHasLeadRecord(e)) && !app.inboxDismissed.has(String(e.id))).length;
  const tabs = document.querySelectorAll('.tab');
  if (tabs[0]) tabs[0].innerHTML = `New Leads <span class="actioned-count">${counts.new_leads}</span>`;
  if (tabs[1]) tabs[1].innerHTML = `Follow-up <span class="actioned-count">${counts.followup + getUnmatchedFollowUpInboxItems().length}</span>`;
  if (tabs[2]) tabs[2].innerHTML = `Ready to Open <span class="actioned-count">${counts.ready}</span>`;
  if (tabs[3]) tabs[3].innerHTML = `Closed <span class="actioned-count">${counts.closed}</span>`;
  if (tabs[4]) tabs[4].innerHTML = `Inbox <span class="actioned-count">${unread}</span>`;
}

function updateTabUi() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === app.currentTab);
  });
}

// ── Hero filter ──────────────────────────────────────────────────────────────
function getHeroFilterFromUrl() {
  const pendingHero = localStorage.getItem(PENDING_HERO_FILTER_KEY);
  if (['urgent', 'stale', 'new'].includes(pendingHero)) {
    localStorage.removeItem(PENDING_HERO_FILTER_KEY);
    return pendingHero;
  }
  const hero = new URLSearchParams(window.location.search).get('hero');
  return ['urgent', 'stale', 'new'].includes(hero) ? hero : 'all';
}

function syncHeroFilterFromUrl() {
  app.heroFilter = getHeroFilterFromUrl();
  if (app.heroFilter === 'new') app.currentTab = 'inbox';
  else if (app.heroFilter === 'urgent' || app.heroFilter === 'stale') app.currentTab = 'new_leads';
}

function clearHeroFilterUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('hero')) return;
  url.searchParams.delete('hero');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}` || url.pathname);
}

function updateHeroFilterUi() {
  document.querySelectorAll('[data-hero-filter]').forEach((btn) => {
    const isActive = btn.dataset.heroFilter === app.heroFilter;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  if (!els.heroFilterIndicator) return;
  const contextLabels = {
    urgent: '\u2190 Back to pipeline \u00b7 Urgent work',
    stale: '\u2190 Back to pipeline \u00b7 At risk',
    new: '\u2190 Back to Inbox \u00b7 New inbox'
  };
  const contextLabel = contextLabels[app.heroFilter] || '';
  els.heroFilterIndicator.hidden = !contextLabel;
  if (contextLabel) {
    const returnTab = app.heroFilter === 'new' ? 'inbox' : 'new_leads';
    els.heroFilterIndicator.innerHTML = `<button class="hero-back-chip" type="button" onclick="clearHeroShortcut('${returnTab}')">${escapeHtml(contextLabel)}</button>`;
  } else {
    els.heroFilterIndicator.innerHTML = '';
  }
}

function applyHeroFilter(filter = 'all') {
  const sameFilter = app.heroFilter === filter;
  app.heroFilter = sameFilter ? 'all' : filter;
  app.currentTab = app.heroFilter === 'new' ? 'inbox' : 'new_leads';
  updateTabUi();
  updateHeroFilterUi();
  render();
}

window.applyHeroFilter = applyHeroFilter;

function clearHeroShortcut(returnTab = 'new_leads') {
  app.heroFilter = 'all';
  app.currentTab = returnTab === 'inbox' ? 'inbox' : 'new_leads';
  clearHeroFilterUrl();
  updateTabUi();
  updateHeroFilterUi();
  render();
}

window.clearHeroShortcut = clearHeroShortcut;

// ── Filter rows ──────────────────────────────────────────────────────────────
function getActiveFilterCount() {
  let count = 0;
  if (els.search && els.search.value.trim()) count++;
  if (els.sourceFilter && els.sourceFilter.value !== 'all') count++;
  if (els.urgencyFilter && els.urgencyFilter.value !== 'all') count++;
  if (els.dateFilter && els.dateFilter.value !== 'all') count++;
  return count;
}

function updateFilterToggleBadge() {
  if (!els.filterToggleLabel) return;
  const count = getActiveFilterCount();
  els.filterToggleLabel.textContent = count > 0 ? `Filters \u00b7 ${count} active` : 'Filters';
}

function filterRows() {
  const query = els.search.value.trim().toLowerCase();
  const source = els.sourceFilter.value;
  const urgency = els.urgencyFilter.value;
  const days = els.dateFilter.value;
  const now = new Date();
  let shown = 0;

  for (const row of document.querySelectorAll('.row, .fu-inbox-card')) {
    const isLeadRow = row.classList.contains('row');
    const isActioned = row.classList.contains('actioned-row');
    const text = row.textContent.toLowerCase();
    const rowSource = row.dataset.source || 'Unknown';
    const rowUrgency = row.dataset.urgency || '';
    const rowDate = parseLeadDate(row.dataset.date || '');
    let visible = true;

    if (isLeadRow) {
      if (app.heroFilter === 'urgent' && rowUrgency !== 'URGENT') visible = false;
      if (app.heroFilter === 'stale') {
        if (!rowDate) visible = false;
        else {
          const elapsedHours = (now - rowDate) / (1000 * 60 * 60);
          if (elapsedHours <= getSlaRiskHours(rowUrgency)) visible = false;
        }
      }
    }
    if (query && !text.includes(query)) visible = false;
    if (source !== 'all' && rowSource !== source) visible = false;
    if (urgency !== 'all' && rowUrgency !== urgency) visible = false;
    if (days !== 'all' && rowDate) {
      const diff = (now - rowDate) / (1000 * 60 * 60 * 24);
      if (diff > Number(days)) visible = false;
    }

    row.style.display = visible ? 'block' : 'none';
    if (visible) shown += 1;
  }

  els.emptyState.hidden = shown !== 0;
  updateFilterToggleBadge();
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderPipelineTab() {
  if (app.heroFilter === 'urgent' || app.heroFilter === 'stale') {
    if (renderHeroFilteredLeads()) return;
  }
  const tab = app.currentTab;
  if (tab === 'new_leads') { renderNewLeadsTab(); return; }
  if (tab === 'followup') { renderFollowUpTab(); return; }
  if (tab === 'ready') { renderReadyTab(); return; }
  if (tab === 'closed') { renderClosedTab(); return; }
}

function render() {
  if (app.currentTab === 'inbox') {
    renderInbox();
    updateTabCounts();
    updateTabUi();
    updateHeroFilterUi();
    updateSummary();
    return;
  }
  const isPipelineTab = ['new_leads', 'followup', 'ready', 'closed'].includes(app.currentTab);
  if (isPipelineTab) {
    const visibleLeads = getVisibleLeads();
    if (!visibleLeads.length && !app.inbox.length) {
      const authRequired = isSupabaseEnabled() && !app.session;
      if (authRequired) app.authPanelOpen = true;
      const emptyMsg = authRequired
        ? `<div class="signin-empty"><strong>Sign in to load live leads</strong><span>LeadFlow is protected. On iPhone, sign in and keep using the Safari page. The old Home Screen icon cannot reliably share the saved magic-link login.</span><button class="btn btn-primary signin-cta" type="button" data-open-auth="1">Sign in in Safari</button></div>`
        : 'No leads available.';
      els.list.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      if (authRequired) refreshAuthUi();
      updateSummary();
      updateTabCounts();
      updateTabUi();
      updateHeroFilterUi();
      return;
    }
    renderPipelineTab();
    updateSummary();
    updateSourceFilter();
    updateTabCounts();
    updateTabUi();
    updateHeroFilterUi();
    filterRows();
    return;
  }
}

// ── Hydrate ──────────────────────────────────────────────────────────────────
async function hydrate() {
  setSyncStatus('Loading…');
  loadLocalState();
  await loadLeads();
  mergeManualLeadsIntoApp();
  await loadInbox();
  void probeAiTriage();
  syncHeroFilterFromUrl();
  migrateLegacyState();
  if (app.supabase && app.session) {
    await loadSupabaseState();
    await syncAllMeaningfulStateRemote();
  }
  render();
  setDefaultSyncStatus();
  startInboxPolling();
}

// ── Interaction handlers ─────────────────────────────────────────────────────
async function handleStateChange(target) {
  const leadId = target.dataset.id;
  const flag = target.dataset.flag;
  if (!leadId || !flag) return;
  setLeadState(leadId, { [flag]: target.checked });
  render();
  try {
    await saveStateRemote(leadId);
  } catch (error) {
    handleError(error);
  }
}

function handleDeleteLead(target) {
  const leadId = target.dataset.deleteId;
  if (!leadId) return;
  const row = target.closest('.row');
  const name = row?.querySelector('.name')?.textContent?.trim() || 'this lead';
  if (!window.confirm(`Delete ${name} from this tracker view?`)) return;
  const lead = app.leads.find((l, i) => getLeadId(l, i) === leadId);
  if (lead?._isManualDraft) {
    removeManualLead(leadId);
    app.leads = app.leads.filter((l) => l.id !== leadId);
  } else {
    void logSecurityEvent('lead.hide_local', String(leadId), {
      source: row?.dataset.source || 'unknown'
    });
    setLeadState(leadId, { hidden: true });
  }
  render();
  showNotice(`${name} deleted from this tracker view.`, 'info');
}

let commentTimer;
async function handleCommentChange(target) {
  const leadId = target.dataset.commentId;
  if (!leadId) return;
  setLeadState(leadId, { comment: target.value });
  clearTimeout(commentTimer);
  commentTimer = setTimeout(async () => {
    try {
      await saveStateRemote(leadId);
    } catch (error) {
      handleError(error);
    }
  }, 350);
}

async function handleProspectStatusChange(target) {
  const leadId = target.dataset.prospectStatusId;
  if (!leadId) return;
  const nextStatus = String(target.value || '');
  const patch = { prospectiveStatus: nextStatus };
  if (nextStatus === 'ready_for_leap' && !getLeadState(leadId).followUpDate) {
    patch.followUpDate = getLocalDateInputValue();
  }
  setLeadState(leadId, patch);
  render();
  try {
    await saveStateRemote(leadId);
  } catch (error) {
    handleError(error);
  }
}

async function handleFollowUpDateChange(target) {
  const leadId = target.dataset.followupDateId;
  if (!leadId) return;
  setLeadState(leadId, { followUpDate: target.value || '' });
  render();
  try {
    await saveStateRemote(leadId);
  } catch (error) {
    handleError(error);
  }
}

async function handlePipelineAction(leadId, action) {
  const patch = {};
  if (action === 'contacted') {
    patch.prospectiveStatus = 'contacted';
  } else if (action === 'not_a_lead') {
    patch.noAction = true;
    patch.actioned = true;
    patch.prospectiveStatus = 'not_a_lead';
  } else if (action === 'existing_matter') {
    patch.noAction = true;
    patch.actioned = true;
    patch.prospectiveStatus = 'existing_matter';
  } else if (action === 'decline') {
    patch.prospectiveStatus = 'declined';
  } else if (action === 'awaiting_reply') {
    patch.prospectiveStatus = 'awaiting_reply';
  } else if (action === 'awaiting_documents') {
    patch.prospectiveStatus = 'awaiting_documents';
  } else if (action === 'awaiting_legal_aid') {
    patch.prospectiveStatus = 'awaiting_legal_aid';
  } else if (action === 'ready_for_leap') {
    patch.prospectiveStatus = 'ready_for_leap';
    if (!getLeadState(leadId).followUpDate) patch.followUpDate = getLocalDateInputValue();
  } else if (action === 'opened_in_leap') {
    patch.prospectiveStatus = 'opened_in_leap';
    patch.actioned = true;
    patch.leap = true;
  } else if (action === 'needs_more_info') {
    patch.prospectiveStatus = 'contacted';
  } else if (action === 'close') {
    patch.prospectiveStatus = 'closed_no_response';
  } else {
    return;
  }
  setLeadState(leadId, patch);
  render();
  try {
    await saveStateRemote(leadId);
  } catch (error) {
    handleError(error);
  }
}

function toggleLeadAccordion(header) {
  const row = header.closest('.row');
  const body = row?.querySelector('.lead-body');
  const leadId = row?.dataset.id;
  if (!body) return;
  const expanding = body.hidden;
  body.hidden = !expanding;
  header.setAttribute('aria-expanded', String(expanding));
  row.classList.toggle('expanded', expanding);
  if (leadId) {
    if (expanding) app.expandedLeads.add(leadId);
    else app.expandedLeads.delete(leadId);
  }
}

// ── Desktop call modal ───────────────────────────────────────────────────────
const callState = { leadId: null, leadName: '', phone: '' };
let callModalBound = false;
const CALL_MODAL_HTML = `
  <div id="callModal" class="call-modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="callModalName">
    <div class="call-modal-card">
      <div class="call-ring-wrap">
        <div class="call-ring call-ring-3"></div>
        <div class="call-ring call-ring-2"></div>
        <div class="call-ring call-ring-1"></div>
        <div class="call-icon-circle">&#128222;</div>
      </div>
      <div class="call-modal-name" id="callModalName"></div>
      <div class="call-modal-phone" id="callModalPhone"></div>
      <div class="call-modal-status">Calling<span class="call-dots"></span></div>
      <div class="call-modal-actions">
        <button class="call-outcome-btn call-outcome-connected" data-outcome="connected">&#10003; Connected</button>
        <button class="call-outcome-btn call-outcome-no-answer" data-outcome="no-answer">No answer</button>
        <button class="call-outcome-btn call-outcome-voicemail" data-outcome="voicemail">Left voicemail</button>
        <button class="call-outcome-btn call-outcome-cancel" data-outcome="cancel">Cancel</button>
      </div>
    </div>
  </div>`;

function isTouchOnlyDevice() {
  const ua = navigator.userAgent || navigator.vendor || '';
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isIPadOs = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  return isMobileUa || isIPadOs || coarsePointer;
}

function ensureCallModal() {
  let modal = document.getElementById('callModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', CALL_MODAL_HTML);
    modal = document.getElementById('callModal');
  }
  return modal;
}

function openCallModal(phone, name, leadId) {
  const modal = ensureCallModal();
  callState.leadId = leadId;
  callState.leadName = name;
  callState.phone = phone;
  modal.querySelector('#callModalName').textContent = name;
  modal.querySelector('#callModalPhone').textContent = phone;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  modal.querySelector('.call-outcome-connected').focus();
}

function closeCallModal() {
  const modal = document.getElementById('callModal');
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
  callState.leadId = null;
}

function resetCallModal() {
  closeCallModal();
  const modal = document.getElementById('callModal');
  if (!modal) return;
  const nameEl = modal.querySelector('#callModalName');
  const phoneEl = modal.querySelector('#callModalPhone');
  if (nameEl) nameEl.textContent = '';
  if (phoneEl) phoneEl.textContent = '';
}

function showCallToast(message) {
  const toast = document.createElement('div');
  toast.className = 'call-success-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function handleCallOutcome(outcome) {
  const { leadId, leadName, phone } = callState;
  closeCallModal();
  if (outcome === 'cancel') return;
  const outcomeLabels = { connected: 'Call connected', 'no-answer': 'No answer', voicemail: 'Left voicemail' };
  const label = outcomeLabels[outcome] || outcome;
  const now = new Date().toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const note = `[${now}] ${label} — called ${phone}`;
  if (leadId) {
    const current = getLeadState(leadId);
    const currentComment = (current.comment || '').trim();
    const newComment = currentComment ? `${currentComment}\n${note}` : note;
    setLeadState(leadId, { comment: newComment, actioned: true });
    const textarea = document.querySelector(`textarea[data-comment-id="${CSS.escape(leadId)}"]`);
    if (textarea) textarea.value = newComment;
    updateTabCounts();
    void saveStateRemote(leadId).catch(handleError);
  }
  showCallToast(`${leadName} — ${label.toLowerCase()} ✓`);
  if (outcome === 'no-answer' || outcome === 'voicemail') {
    const lead = leadId ? app.leads.find((l, i) => getLeadId(l, i) === leadId) : null;
    if (lead) setTimeout(() => openDraftComposer(lead, 'both', outcome), 200);
  }
}

function attachCallModal() {
  if (!callModalBound) {
    document.addEventListener('click', (event) => {
      const modal = document.getElementById('callModal');
      if (!modal) return;
      const btn = event.target.closest('[data-outcome]');
      if (btn) { handleCallOutcome(btn.dataset.outcome); return; }
      if (event.target === modal) closeCallModal();
    });
    document.addEventListener('keydown', (event) => {
      const liveModal = document.getElementById('callModal');
      if (event.key === 'Escape' && liveModal && !liveModal.hidden) closeCallModal();
    });
    window.addEventListener('pageshow', () => { resetCallModal(); });
    callModalBound = true;
  }
  resetCallModal();
}

// ── Draft composer — local templates only (no external API calls) ─────────────
// NOTE: The /api/generate-draft endpoint from the demo is intentionally NOT
// wired here. Generating AI drafts requires sending lead data (name, matter
// details, location) to a third-party LLM API. Given this app handles real
// client PII, that step needs a privacy/consent review before enabling.
// The composer still provides useful Generic and Personalised local templates.

let draftModalBound = false;

const DRAFT_MODAL_HTML = `
  <div id="draftModal" class="draft-modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="draftModalTitle">
    <div class="draft-modal-card">
      <div class="draft-modal-header">
        <span class="draft-modal-title" id="draftModalTitle">Draft Message</span>
        <button class="draft-modal-close" data-close-draft aria-label="Close">&times;</button>
      </div>
      <div class="draft-notice">Review before sending</div>
      <div class="draft-style-toggle" id="draftStyleToggle" hidden></div>
      <div class="draft-tabs" id="draftTabs"></div>
      <div class="draft-panel" id="draftSmsPanel">
        <label class="draft-field-label">To (phone)</label>
        <div class="draft-to" id="draftSmsTo"></div>
        <label class="draft-field-label" for="draftSmsBody">Message</label>
        <textarea class="draft-textarea comment-box" id="draftSmsBody" rows="5"></textarea>
        <a class="draft-booking-link" href="https://lawtap.com/au/lawyer/jacqui-griffin.html" target="_blank" rel="noopener">Booking link included</a>
        <div class="draft-actions">
          <button class="btn btn-primary" data-send-sms>&#128172; Send SMS</button>
          <button class="btn btn-secondary" data-close-draft>Close</button>
        </div>
      </div>
      <div class="draft-panel" id="draftEmailPanel" hidden>
        <label class="draft-field-label">To (email)</label>
        <div class="draft-to" id="draftEmailTo"></div>
        <label class="draft-field-label" for="draftEmailSubject">Subject</label>
        <input class="draft-subject-input" id="draftEmailSubject" type="text"/>
        <label class="draft-field-label" for="draftEmailBody">Body</label>
        <textarea class="draft-textarea comment-box" id="draftEmailBody" rows="8"></textarea>
        <a class="draft-booking-link" href="https://lawtap.com/au/lawyer/jacqui-griffin.html" target="_blank" rel="noopener">Booking link included</a>
        <div class="draft-actions">
          <button class="btn btn-primary" data-send-email>&#9993;&#65039; Send email</button>
          <button class="btn btn-secondary" data-close-draft>Close</button>
        </div>
      </div>
      <div class="draft-status" id="draftStatus" hidden></div>
    </div>
  </div>`;

const BOOKING_LINK = 'https://lawtap.com/au/lawyer/jacqui-griffin.html';
const SMS_SIGNATURE = `Jacqui Griffin\n0408 961 344\njacquigriffin@mobilesolicitor.com.au`;
const EMAIL_SIGNATURE = `Regards\nJacqui Griffin\n\nJacqui Griffin Mobile Solicitor\nLevel 7, 91 Phillip Street\nParramatta NSW 2150\n\nPO Box 1272\nParramatta NSW 2124\n\nPh: + 61 2 9891 0008\n0408 961 344\nFax: + 61 2 8007 0513\n\nEmail: jacquigriffin@mobilesolicitor.com.au`;

function getFirstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function cleanDraftText(value, maxLen = 140) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, '')
    .trim()
    .slice(0, maxLen);
}

function getLeadDetailSummary(lead, maxLen = 120) {
  const candidates = [lead.raw_preview, lead.notes, lead.subject];
  for (const candidate of candidates) {
    const cleaned = cleanDraftText(candidate, maxLen);
    if (cleaned && cleaned.toLowerCase() !== 'unknown') return cleaned;
  }
  return '';
}

function lowerFirst(value) {
  const text = String(value || '').trim();
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function getLeadContextPhrase(lead) {
  const matter = cleanDraftText(lead.matter_type, 60) || 'legal';
  const detail = getLeadDetailSummary(lead, 115);
  if (!detail) return `your ${matter} enquiry`;
  return `your ${matter} enquiry about ${detail}`;
}

function buildSmsDraft(lead, callOutcome) {
  const first = getFirstName(lead.sender_name);
  const intro = callOutcome === 'no-answer'
    ? `Hi ${first}, I tried to call you today. `
    : callOutcome === 'voicemail'
      ? `Hi ${first}, I left you a voicemail today. `
      : `Hi ${first}, `;
  return `${intro}I have received your enquiry and invite you to book a call with me to discuss your matter here: ${BOOKING_LINK}\n\nIf you wish to provide further information in the meantime, please do so.\n\n${SMS_SIGNATURE}`;
}

function buildPersonalisedSmsDraft(lead, callOutcome) {
  const first = getFirstName(lead.sender_name);
  const context = getLeadContextPhrase(lead);
  const intro = callOutcome === 'no-answer'
    ? `Hi ${first}, I tried to call you today about ${context}. `
    : callOutcome === 'voicemail'
      ? `Hi ${first}, I left you a voicemail today about ${context}. `
      : `Hi ${first}, thank you for your message about ${context}. `;
  return `${intro}I've read the details you sent. Please book a call so we can discuss the next steps: ${BOOKING_LINK}\n\n${SMS_SIGNATURE}`;
}

function buildEmailDraft(lead, callOutcome) {
  const first = getFirstName(lead.sender_name);
  const matter = String(lead.matter_type || '').trim() || 'legal';
  const matterLower = lowerFirst(matter);
  const subject = callOutcome === 'no-answer' || callOutcome === 'voicemail'
    ? `Following up on your ${matter} enquiry — Jacqui Griffin`
    : (lead.subject || `Re: Your ${matter} enquiry`);
  const intro = callOutcome === 'no-answer'
    ? `I tried to call you today regarding your ${matter} enquiry.`
    : callOutcome === 'voicemail'
      ? `I left you a voicemail today regarding your ${matter} enquiry.`
      : `Thank you for getting in touch about your ${matterLower} enquiry.`;
  const urgency = String(lead.priority || '').toUpperCase() === 'URGENT' ? `\n\nI understand this may be time-sensitive.` : '';
  const infoPrompt = String(lead.priority || '').toUpperCase() === 'URGENT'
    ? 'If there is an upcoming court date or anything urgent you would like me to know, please feel free to reply with those details in the meantime.'
    : 'If you would like to provide any further background before we speak, please feel free to reply in the meantime.';
  const bookingBlock = `You are welcome to book a call with me to discuss your matter using the link below:\n\n${BOOKING_LINK}\n\n${infoPrompt}`;
  return {
    subject,
    body: `Dear ${first},\n\n${intro}${urgency}\n\n${bookingBlock}\n\n${EMAIL_SIGNATURE}`
  };
}

function buildPersonalisedEmailDraft(lead, callOutcome) {
  const first = getFirstName(lead.sender_name);
  const matter = cleanDraftText(lead.matter_type, 60) || 'legal';
  const matterLower = lowerFirst(matter);
  const isUrgent = String(lead.priority || '').toUpperCase() === 'URGENT';
  const detail = getLeadDetailSummary(lead, 180);
  const subject = callOutcome === 'no-answer' || callOutcome === 'voicemail'
    ? `Following up on your ${matter} enquiry — Jacqui Griffin`
    : (lead.subject || `Re: Your ${matter} enquiry`);
  const intro = callOutcome === 'no-answer'
    ? `I tried to call you today regarding your ${matter} enquiry.`
    : callOutcome === 'voicemail'
      ? `I left you a voicemail today regarding your ${matter} enquiry.`
      : `Thank you for your email about your ${matterLower} matter.`;
  const ackDetail = detail ? lowerFirst(detail) : '';
  const ack = ackDetail
    ? `\n\nI have read the details you provided, including: ${ackDetail}.`
    : `\n\nI have read the details you provided and would be glad to discuss the matter with you.`;
  const urgency = isUrgent ? `\n\nI understand this matter may be time-sensitive.` : '';
  const infoPrompt = isUrgent
    ? 'If there are any upcoming dates or further details relevant to your situation, please feel free to include them in a reply in the meantime.'
    : 'If there is any additional context you would like to share before we speak, please feel free to reply with those details.';
  const bookingBlock = `I would welcome the opportunity to speak with you about your situation. Please book a time that suits you:\n\n${BOOKING_LINK}\n\n${infoPrompt}`;
  return {
    subject,
    body: `Dear ${first},\n\n${intro}${ack}${urgency}\n\n${bookingBlock}\n\n${EMAIL_SIGNATURE}`
  };
}

function buildLocalDrafts(lead, callOutcome, draftStyle) {
  const personalised = draftStyle === 'personalised';
  return {
    sms: { body: personalised ? buildPersonalisedSmsDraft(lead, callOutcome) : buildSmsDraft(lead, callOutcome) },
    email: personalised ? buildPersonalisedEmailDraft(lead, callOutcome) : buildEmailDraft(lead, callOutcome)
  };
}

function setDraftStyleToggle(modal, draftStyle) {
  modal.querySelectorAll('[data-draft-style]').forEach((btn) => {
    btn.classList.toggle('draft-style-btn-active', btn.dataset.draftStyle === draftStyle);
  });
}

function applyDraftContent(modal, drafts, canSms, canEmail) {
  if (canSms && drafts?.sms?.body) {
    modal.querySelector('#draftSmsBody').value = drafts.sms.body;
  }
  if (canEmail && drafts?.email) {
    modal.querySelector('#draftEmailSubject').value = drafts.email.subject || '';
    modal.querySelector('#draftEmailBody').value = drafts.email.body || '';
  }
}

function ensureDraftModal() {
  let modal = document.getElementById('draftModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', DRAFT_MODAL_HTML);
    modal = document.getElementById('draftModal');
  }
  return modal;
}

function closeDraftModal() {
  const modal = document.getElementById('draftModal');
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
}

function openDraftComposer(lead, mode, callOutcome) {
  const modal = ensureDraftModal();
  const phone = lead.sender_phone || lead.phone || '';
  const email = lead.sender_email || '';
  const canSms = (mode === 'sms' || mode === 'both') && phone && phone !== 'Unknown' && phone !== 'Check SMS app';
  const canEmail = (mode === 'email' || mode === 'both') && email && email !== 'Unknown';

  // Default to personalised when body content is available
  const hasContent = Boolean(String(lead.raw_preview || lead.notes || '').trim());
  const draftStyle = hasContent ? 'personalised' : 'generic';

  // Style toggle — switches between Generic and Personalised local templates
  const draftStyleToggle = modal.querySelector('#draftStyleToggle');
  draftStyleToggle.innerHTML =
    `<button class="draft-style-btn${draftStyle === 'generic' ? ' draft-style-btn-active' : ''}" data-draft-style="generic">Generic</button>` +
    `<button class="draft-style-btn${draftStyle === 'personalised' ? ' draft-style-btn-active' : ''}" data-draft-style="personalised">Personalised</button>`;
  draftStyleToggle.hidden = false;

  // Tabs (only when both SMS and email are available)
  const draftTabs = modal.querySelector('#draftTabs');
  if (canSms && canEmail) {
    draftTabs.hidden = false;
    draftTabs.innerHTML =
      '<button class="draft-tab draft-tab-active" data-draft-tab="sms">&#128172; SMS</button>' +
      '<button class="draft-tab" data-draft-tab="email">&#9993; Email</button>';
  } else {
    draftTabs.hidden = true;
    draftTabs.innerHTML = '';
  }

  const smsPanel = modal.querySelector('#draftSmsPanel');
  if (canSms) {
    modal.querySelector('#draftSmsTo').textContent = phone;
    smsPanel.hidden = false;
  } else {
    smsPanel.hidden = true;
  }

  const emailPanel = modal.querySelector('#draftEmailPanel');
  if (canEmail) {
    modal.querySelector('#draftEmailTo').textContent = email;
    emailPanel.hidden = canSms; // hide email panel initially when both tabs shown
  } else {
    emailPanel.hidden = true;
  }

  let title = 'Draft Message';
  if (callOutcome === 'no-answer') title = 'Draft Follow-up \u2014 No Answer';
  else if (callOutcome === 'voicemail') title = 'Draft Follow-up \u2014 Voicemail Left';
  else if (mode === 'sms') title = 'Draft SMS';
  else if (mode === 'email') title = 'Draft Email';
  modal.querySelector('#draftModalTitle').textContent = title;

  modal.draftContext = { leadId: String(lead.id ?? lead.lead_id ?? ''), canSms, canEmail, mode, callOutcome, lead, draftStyle };

  // Apply local templates immediately (no external API call)
  applyDraftContent(modal, buildLocalDrafts(lead, callOutcome, draftStyle), canSms, canEmail);

  const statusEl = modal.querySelector('#draftStatus');
  if (statusEl) statusEl.hidden = true;

  modal.hidden = false;
  document.body.style.overflow = 'hidden';

  const firstPanel = smsPanel.hidden ? emailPanel : smsPanel;
  const ta = firstPanel?.querySelector('textarea');
  if (ta) setTimeout(() => ta.focus(), 60);
}

function isAppleMobileMessaging() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIPadOs = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return isIOS || isIPadOs;
}

function openSmsDraft(to, body) {
  const phone = String(to || '').trim();
  const separator = isAppleMobileMessaging() ? '&' : '?';
  window.location.href = `sms:${phone}${separator}body=${encodeURIComponent(body)}`;
}

function openEmailDraft(to, subject, body) {
  const email = String(to || '').trim();
  const normalizedBody = String(body || '').replace(/\r?\n/g, '\r\n').trimEnd() + '\r\n';
  window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(normalizedBody)}`;
}

function attachDraftModal() {
  if (draftModalBound) return;
  document.addEventListener('click', (event) => {
    const modal = document.getElementById('draftModal');
    if (!modal || modal.hidden) return;

    if (event.target.closest('[data-close-draft]')) { closeDraftModal(); return; }
    if (event.target === modal) { closeDraftModal(); return; }

    const tab = event.target.closest('[data-draft-tab]');
    if (tab && modal.contains(tab)) {
      const target = tab.dataset.draftTab;
      modal.querySelectorAll('.draft-tab').forEach((t) => t.classList.toggle('draft-tab-active', t === tab));
      modal.querySelector('#draftSmsPanel').hidden = target !== 'sms';
      modal.querySelector('#draftEmailPanel').hidden = target !== 'email';
      return;
    }

    const styleBtn = event.target.closest('[data-draft-style]');
    if (styleBtn && modal.contains(styleBtn)) {
      const newStyle = styleBtn.dataset.draftStyle;
      const context = modal.draftContext;
      if (context && newStyle !== context.draftStyle) {
        context.draftStyle = newStyle;
        setDraftStyleToggle(modal, newStyle);
        applyDraftContent(modal, buildLocalDrafts(context.lead, context.callOutcome, newStyle), context.canSms, context.canEmail);
      }
      return;
    }

    const sendSmsBtn = event.target.closest('[data-send-sms]');
    if (sendSmsBtn && modal.contains(sendSmsBtn)) {
      const to = modal.querySelector('#draftSmsTo').textContent.trim();
      const body = modal.querySelector('#draftSmsBody').value;
      openSmsDraft(to, body);
      return;
    }

    const sendEmailBtn = event.target.closest('[data-send-email]');
    if (sendEmailBtn && modal.contains(sendEmailBtn)) {
      const to = modal.querySelector('#draftEmailTo').textContent.trim();
      const subject = modal.querySelector('#draftEmailSubject').value;
      const body = modal.querySelector('#draftEmailBody').value;
      openEmailDraft(to, subject, body);
      return;
    }
  });
  document.addEventListener('keydown', (event) => {
    const modal = document.getElementById('draftModal');
    if (event.key === 'Escape' && modal && !modal.hidden) closeDraftModal();
  });
  draftModalBound = true;
}

// ── Event binding ────────────────────────────────────────────────────────────
function attachEvents() {
  // Hero tile taps — capture-phase delegation, de-duped, for iOS Safari reliability
  let _heroTapTs = 0;
  const _handleHeroTile = (e) => {
    const tile = e.target.closest('[data-hero-filter]');
    if (!tile) return;
    const now = Date.now();
    const isDupe = (now - _heroTapTs) < 400;
    _heroTapTs = now;
    if (e.type === 'click') {
      e.preventDefault();
      if (isDupe) return;
    }
    if (isDupe) return;
    applyHeroFilter(tile.dataset.heroFilter);
  };
  document.addEventListener('pointerup', _handleHeroTile, { capture: true });
  document.addEventListener('touchend', _handleHeroTile, { capture: true, passive: true });
  document.addEventListener('click', _handleHeroTile, { capture: true });

  if (els.filterToggle && els.filterPanel) {
    els.filterToggle.addEventListener('click', () => {
      const isOpen = els.filterPanel.classList.toggle('open');
      els.filterToggle.setAttribute('aria-expanded', String(isOpen));
      els.filterToggle.classList.toggle('filter-panel-open', isOpen);
    });
  }

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      app.currentTab = button.dataset.tab;
      app.heroFilter = 'all';
      clearHeroFilterUrl();
      updateTabUi();
      updateHeroFilterUi();
      render();
    });
  });

  [els.search, els.sourceFilter, els.dateFilter, els.urgencyFilter].forEach((el) => {
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', filterRows);
  });

  els.list.addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"][data-flag]')) handleStateChange(event.target);
    if (event.target.matches('textarea[data-comment-id]')) handleCommentChange(event.target);
    if (event.target.matches('select[data-prospect-status-id]')) void handleProspectStatusChange(event.target);
    if (event.target.matches('input[data-followup-date-id]')) void handleFollowUpDateChange(event.target);
  });
  els.list.addEventListener('input', (event) => {
    if (event.target.matches('textarea[data-comment-id]')) handleCommentChange(event.target);
  });
  els.list.addEventListener('click', (event) => {
    const pipelineBtn = event.target.closest('button[data-pipeline-action]');
    if (pipelineBtn) {
      void handlePipelineAction(pipelineBtn.dataset.pipelineId, pipelineBtn.dataset.pipelineAction);
      return;
    }
    if (event.target.matches('button[data-delete-id]')) { handleDeleteLead(event.target); return; }
    if (event.target.matches('button[data-import-id]')) { importInboxEmail(event.target.dataset.importId); return; }
    if (event.target.matches('button[data-followup-import-id]')) { importInboxEmailAsFollowUp(event.target.dataset.followupImportId); return; }
    if (event.target.matches('button[data-existing-import-id]')) { importInboxEmailAsExistingMatter(event.target.dataset.existingImportId); return; }
    if (event.target.matches('button[data-dismiss-id]')) { dismissInboxEmail(event.target.dataset.dismissId); return; }
    if (event.target.matches('button[data-restore-id]')) { undismissInboxEmail(event.target.dataset.restoreId); return; }
    if (event.target.matches('button[data-toggle-dismissed]')) { toggleInboxShowDismissed(); return; }
    if (event.target.matches('button[data-triage-id]')) { void triageInboxEmail(event.target.dataset.triageId); return; }
    if (event.target.matches('button[data-clear-triage]')) { clearAiTriage(event.target.dataset.clearTriage); return; }

    const callBtn = event.target.closest('button[data-call-phone]');
    if (callBtn) {
      const phone = callBtn.dataset.callPhone;
      const name = callBtn.dataset.callName;
      const leadId = callBtn.dataset.callId;
      if (isTouchOnlyDevice()) {
        window.location.href = `tel:${phone}`;
      } else {
        openCallModal(phone, name, leadId);
      }
      return;
    }

    const smsDraftBtn = event.target.closest('button[data-draft-sms]');
    if (smsDraftBtn) {
      const leadId = smsDraftBtn.dataset.draftSms;
      const lead = app.leads.find((l, i) => getLeadId(l, i) === leadId);
      if (lead) openDraftComposer(lead, 'sms');
      return;
    }

    const emailDraftBtn = event.target.closest('button[data-draft-email]');
    if (emailDraftBtn) {
      const leadId = emailDraftBtn.dataset.draftEmail;
      const lead = app.leads.find((l, i) => getLeadId(l, i) === leadId);
      if (lead) openDraftComposer(lead, 'email');
      return;
    }

    const header = event.target.closest('.lead-header');
    if (header && !event.target.closest('a, button, input, textarea, select')) {
      toggleLeadAccordion(header);
    }
  });

  els.list.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('lead-header')) {
      event.preventDefault();
      toggleLeadAccordion(event.target);
    }
  });

  els.updateNowLink.addEventListener('click', () => {
    try { localStorage.removeItem('xena-leads-data-import'); } catch {}
  });

  els.showAuthBtn.addEventListener('click', () => {
    app.authPanelOpen = !app.authPanelOpen;
    refreshAuthUi();
    if (app.authPanelOpen && !app.session) els.authEmail.focus();
  });

  document.addEventListener('click', (event) => {
    const openAuth = event.target.closest('[data-open-auth]');
    if (!openAuth) return;
    event.preventDefault();
    app.authPanelOpen = true;
    refreshAuthUi();
    els.authPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => els.authEmail?.focus(), 250);
  });

  els.sendMagicLinkBtn.addEventListener('click', async () => {
    const originalLabel = els.sendMagicLinkBtn.textContent;
    try {
      if (!(app.supabase && isSupabaseEnabled())) return;
      const email = els.authEmail.value.trim();
      if (!email) throw new Error('Enter an email address first.');
      const cooldownRemainingMs = getMagicLinkCooldownRemainingMs();
      if (cooldownRemainingMs > 0) {
        setDefaultSyncStatus();
        showNotice(`Check your email or wait ${Math.ceil(cooldownRemainingMs / 1000)} seconds before requesting another sign-in link.`, 'info');
        return;
      }
      els.sendMagicLinkBtn.disabled = true;
      els.sendMagicLinkBtn.textContent = 'Sending…';
      const { error } = await app.supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
      });
      if (error) throw error;
      setMagicLinkCooldown();
      setSyncStatus('Email sent');
      const _isPwa = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
      showNotice(
        _isPwa
          ? 'Magic link sent. It will open in Safari. After signing in, keep using the Safari page — the old Home Screen app has separate storage and may still look signed out.'
          : 'Magic link sent. Open it in Safari, then keep using this Safari page. Your session should persist here.',
        'info'
      );
    } catch (error) {
      const message = error?.message || '';
      if (/rate limit/i.test(message)) {
        setMagicLinkCooldown();
        setDefaultSyncStatus();
        showNotice('Too many sign-in emails were requested. Wait about a minute, then try again in the same browser, ideally Safari on iPhone.', 'info');
        return;
      }
      handleError(error);
    } finally {
      els.sendMagicLinkBtn.disabled = false;
      els.sendMagicLinkBtn.textContent = originalLabel;
    }
  });

  els.signOutBtn.addEventListener('click', async () => {
    try {
      await app.supabase.auth.signOut();
      app.session = null;
      app.hasLoggedLeadRead = false;
      app.authPanelOpen = false;
      showNotice('Signed out.', 'info');
      refreshAuthUi();
      await hydrate();
    } catch (error) {
      handleError(error);
    }
  });
}

// ── Error handling ───────────────────────────────────────────────────────────
function handleError(error) {
  console.error(error);
  const message = error?.message || 'Something went wrong.';
  if (/rate limit/i.test(message)) {
    setDefaultSyncStatus();
    showNotice('Too many sign-in emails were requested. Wait about a minute, then try again in the same browser, ideally Safari on iPhone.', 'info');
    return;
  }
  setSyncStatus(app.supabase && app.session ? 'Sync issue' : 'Saved on this phone');
  showNotice(message, 'error');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  attachEvents();
  attachCallModal();
  attachDraftModal();
  attachAddLeadModal();
  await loadConfig();
  await initSupabase();
  await hydrate();
  window.__heroReady = true;
  window.__heroFallback = (f) => applyHeroFilter(f);
}

start().catch(handleError);
