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
  currentTab: 'active',
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
  return app.state[id] || { actioned: false, leap: false, noAction: false, laAccepted: false, hidden: false, comment: '' };
}

function hasMeaningfulState(state) {
  return Boolean(
    state?.actioned ||
    state?.leap ||
    state?.noAction ||
    state?.laAccepted ||
    state?.hidden ||
    String(state?.comment || '').trim()
  );
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
  app.currentTab = 'active';
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
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  app.supabase = createClient(app.config.supabase.url, app.config.supabase.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data } = await app.supabase.auth.getSession();
  app.session = data.session;
  refreshAuthUi();
  app.supabase.auth.onAuthStateChange((_event, session) => {
    app.session = session;
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
    els.authStatus.textContent = 'Sign in once to sync across phone and laptop. On iPhone, open the magic link in Safari and keep using Safari for the tracker.';
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
  const newUnread = app.inbox.filter((e) => !app.inboxImported.has(String(e.id)) && !app.inboxDismissed.has(String(e.id))).length;
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
    ? `<button class="btn-import" type="button" data-import-id="${emailIdEsc}">&#x2192; Import as Lead</button><button class="btn-restore" type="button" data-restore-id="${emailIdEsc}">&#x21BA; Restore</button>`
    : `<button class="btn-import" type="button" data-import-id="${emailIdEsc}">&#x2192; Import as Lead</button><button class="btn-dismiss" type="button" data-dismiss-id="${emailIdEsc}">Dismiss</button>${aiTriageBtn}`;

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
  const pending = app.inbox.filter((e) => !app.inboxImported.has(String(e.id)) && !app.inboxDismissed.has(String(e.id)));
  const dismissed = app.inbox.filter((e) => !app.inboxImported.has(String(e.id)) && app.inboxDismissed.has(String(e.id)));

  const accounts = (app.inboxAccounts && app.inboxAccounts.length) ? app.inboxAccounts : [app.inboxAccount || 'Inbox'];
  const accountLabel = accounts.join(', ');

  const staleBanner = (!app.inboxLive && app.inboxTransientError)
    ? '<div class="inbox-stale-note">Inbox temporarily unavailable \u2014 showing last loaded messages. Retrying automatically.</div>'
    : '';
  const hiddenNote = app.inboxHiddenCount > 0
    ? ` &mdash; <span title="System notifications, deployment alerts and auth emails are excluded automatically.">${app.inboxHiddenCount} system email${app.inboxHiddenCount !== 1 ? 's' : ''} filtered</span>`
    : '';
  let html = staleBanner + `<div class="inbox-header">Live inbox (likely leads) &mdash; <strong>${escapeHtml(accountLabel)}</strong> &mdash; ${pending.length} message${pending.length !== 1 ? 's' : ''}${hiddenNote}. <em>Import as Lead</em> adds to tracker. <em>Dismiss</em> hides here only &mdash; email stays in your mailbox.</div>`;

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
function importInboxEmail(emailId) {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email) return;
  const sourceMeta = getSourceMeta(email.source_account || app.inboxAccount || 'Inbox');
  void logSecurityEvent('inbox.import', String(email.id), {
    source: sourceMeta.key,
    from_domain: getEmailDomain(email.from_email),
    has_phone: Boolean(email.phone)
  });
  app.inboxImported.add(String(email.id));
  persistInboxImported();
  const lead = {
    id: email.id,
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
    status: 'new',
    notes: '',
    raw_preview: email.snippet || '',
    next_action: email.next_action || 'Reply to email',
    location: email.location || 'Unknown',
    opposing_party: email.opposing_party || 'Unknown'
  };
  app.leads.unshift(lead);
  app.currentTab = 'active';
  app.heroFilter = 'all';
  updateTabUi();
  updateHeroFilterUi();
  render();
  showNotice(`${email.from_name} imported to Active leads.`, 'info');
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
      comment: row.comment || ''
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
  const { error } = await app.supabase.from('lead_states').upsert({
    lead_id: Number(leadId),
    user_id: app.session.user.id,
    actioned: state.actioned,
    leap: state.leap,
    no_action: state.noAction,
    la_accepted: state.laAccepted,
    comment: state.comment
  }, { onConflict: 'user_id,lead_id' });
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
  for (const [leadId, state] of entries) {
    const { error } = await app.supabase.from('lead_states').upsert({
      lead_id: Number(leadId),
      user_id: app.session.user.id,
      actioned: Boolean(state.actioned),
      leap: Boolean(state.leap),
      no_action: Boolean(state.noAction),
      la_accepted: Boolean(state.laAccepted),
      comment: state.comment || ''
    }, { onConflict: 'user_id,lead_id' });
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

  const isExpanded = app.expandedLeads.has(id);

  return `<div class="row ${rowClass}${isExpanded ? ' expanded' : ''}" data-id="${escapeHtml(id)}" data-source="${escapeHtml(sourceMeta.key)}" data-date="${escapeHtml(lead.date_received || date)}" data-urgency="${escapeHtml(priorityValue)}">
    <div class="lead-header" role="button" aria-expanded="${isExpanded}" tabindex="0">
      <div class="lead-main">
        <div class="lead-main-top">
          <div class="lead-heading">
            <div class="name">${escapeHtml(lead.sender_name || 'Unknown')}</div>
          </div>
          <div class="pill ${pillClass(lead.priority)} priority-pill">${escapeHtml(priorityLabel)}</div>
        </div>
        <div class="meta">${agoBadge}<span>${escapeHtml(date)}</span><span class="meta-sep">•</span><span>${escapeHtml(sourceLabel)}</span>${manualBadge}</div>
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
      <div class="grid">
        <div class="field"><strong>Email</strong>${hasEmail ? `<a class="contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '<span class="unknown">Unknown</span>'}</div>
        <div class="field"><strong>Phone</strong>${hasPhone ? `<a class="contact-link" href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : `<span class="unknown">${escapeHtml(phone || 'Unknown')}</span>`}</div>
      </div>
      ${actionMarkup}
      <div class="field summary-field"><strong>Summary</strong>${escapeHtml(summary)}</div>
      <div class="leap-row">
        <div class="leap-item actioned-item"><input type="checkbox" data-flag="actioned" data-id="${escapeHtml(id)}" ${state.actioned ? 'checked' : ''}><label>&#x2705; Actioned</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="leap" data-id="${escapeHtml(id)}" ${state.leap ? 'checked' : ''}><label>LEAP Client</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="noAction" data-id="${escapeHtml(id)}" ${state.noAction ? 'checked' : ''}><label>No Action</label></div>
        <div class="leap-item"><input type="checkbox" data-flag="laAccepted" data-id="${escapeHtml(id)}" ${state.laAccepted ? 'checked' : ''}><label>LA</label></div>
      </div>
      <div class="comment-wrap"><strong>Comment</strong><textarea class="comment-box" data-comment-id="${escapeHtml(id)}" placeholder="Add a comment...">${escapeHtml(state.comment || '')}</textarea></div>
    </div>
  </div>`;
}

// ── Summary / hero stats ─────────────────────────────────────────────────────
function updateSummary() {
  const visibleLeads = getVisibleLeads();
  const activeLeads = visibleLeads.filter((lead, i) => !getLeadState(getLeadId(lead, app.leads.indexOf(lead))).actioned);
  const urgentCount = activeLeads.filter((lead) => String(lead.priority || '').toUpperCase() === 'URGENT').length;
  const agingCount = activeLeads.filter(isLeadAtSlaRisk).length;
  const unread = app.inbox.filter((e) => !app.inboxImported.has(String(e.id)) && !app.inboxDismissed.has(String(e.id))).length;

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
  const active = visibleLeads.filter((lead) => !getLeadState(getLeadId(lead, app.leads.indexOf(lead))).actioned).length;
  const actioned = visibleLeads.length - active;
  const unread = app.inbox.filter((e) => !app.inboxImported.has(String(e.id)) && !app.inboxDismissed.has(String(e.id))).length;
  const tabs = document.querySelectorAll('.tab');
  if (tabs[0]) tabs[0].innerHTML = `Active <span class="actioned-count">${active}</span>`;
  if (tabs[1]) tabs[1].innerHTML = `Actioned <span class="actioned-count">${actioned}</span>`;
  if (tabs[2]) tabs[2].innerHTML = `Inbox <span class="actioned-count">${unread}</span>`;
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
  else if (app.heroFilter === 'urgent' || app.heroFilter === 'stale') app.currentTab = 'active';
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
    urgent: '\u2190 Back to Active \u00b7 Urgent leads',
    stale: '\u2190 Back to Active \u00b7 At risk',
    new: '\u2190 Back to Inbox \u00b7 New inbox'
  };
  const contextLabel = contextLabels[app.heroFilter] || '';
  els.heroFilterIndicator.hidden = !contextLabel;
  if (contextLabel) {
    const returnTab = app.heroFilter === 'new' ? 'inbox' : 'active';
    els.heroFilterIndicator.innerHTML = `<button class="hero-back-chip" type="button" onclick="clearHeroShortcut('${returnTab}')">${escapeHtml(contextLabel)}</button>`;
  } else {
    els.heroFilterIndicator.innerHTML = '';
  }
}

function applyHeroFilter(filter = 'all') {
  const sameFilter = app.heroFilter === filter;
  app.heroFilter = sameFilter ? 'all' : filter;
  app.currentTab = app.heroFilter === 'new' ? 'inbox' : 'active';
  updateTabUi();
  updateHeroFilterUi();
  render();
}

window.applyHeroFilter = applyHeroFilter;

function clearHeroShortcut(returnTab = 'active') {
  app.heroFilter = 'all';
  app.currentTab = returnTab === 'inbox' ? 'inbox' : 'active';
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

  for (const row of document.querySelectorAll('.row')) {
    const isActioned = row.classList.contains('actioned-row');
    const text = row.textContent.toLowerCase();
    const rowSource = row.dataset.source || 'Unknown';
    const rowUrgency = row.dataset.urgency || '';
    const rowDate = parseLeadDate(row.dataset.date || '');
    let visible = true;

    if (app.currentTab === 'active' && isActioned) visible = false;
    if (app.currentTab === 'actioned' && !isActioned) visible = false;
    if (app.heroFilter === 'urgent' && rowUrgency !== 'URGENT') visible = false;
    if (app.heroFilter === 'stale') {
      if (!rowDate) visible = false;
      else {
        const elapsedHours = (now - rowDate) / (1000 * 60 * 60);
        if (elapsedHours <= getSlaRiskHours(rowUrgency)) visible = false;
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
function render() {
  if (app.currentTab === 'inbox') {
    renderInbox();
    updateTabCounts();
    updateTabUi();
    updateHeroFilterUi();
    updateSummary();
    return;
  }
  const visibleLeads = getVisibleLeads();
  if (!visibleLeads.length) {
    const authRequired = isSupabaseEnabled() && !app.session;
    if (authRequired) app.authPanelOpen = true;
    const emptyMsg = authRequired
      ? `<div class="signin-empty"><strong>Sign in to load live leads</strong><span>LeadFlow is protected. Use your approved email, then open the magic link in Safari on this iPhone.</span><button class="btn btn-primary signin-cta" type="button" data-open-auth="1">Sign in to load live leads</button></div>`
      : 'No leads available.';
    els.list.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    if (authRequired) refreshAuthUi();
    updateSummary();
    updateTabCounts();
    updateTabUi();
    updateHeroFilterUi();
    filterRows();
    return;
  }
  els.list.innerHTML = visibleLeads.map((lead) => renderLead(lead, app.leads.indexOf(lead))).join('');
  updateSummary();
  updateSourceFilter();
  updateTabCounts();
  updateTabUi();
  updateHeroFilterUi();
  filterRows();
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
  });
  els.list.addEventListener('input', (event) => {
    if (event.target.matches('textarea[data-comment-id]')) handleCommentChange(event.target);
  });
  els.list.addEventListener('click', (event) => {
    if (event.target.matches('button[data-delete-id]')) { handleDeleteLead(event.target); return; }
    if (event.target.matches('button[data-import-id]')) { importInboxEmail(event.target.dataset.importId); return; }
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
      showNotice('Magic link sent. Open it in the same browser you use for the tracker, ideally Safari on iPhone.', 'info');
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
