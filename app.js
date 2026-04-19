const LEGACY_STORAGE_KEY = 'xena-leads-state-v3';
const STATE_STORAGE_KEY = 'xena-leads-state-v4';
const MAGIC_LINK_COOLDOWN_KEY = 'xena-leads-magic-link-cooldown-until';
const MAGIC_LINK_COOLDOWN_MS = 60 * 1000;
const CONFIG_PATH = './config.js';
const INBOX_IMPORTED_KEY = 'xena-leads-inbox-imported';
const DEFAULT_CONFIG = { supabase: { enabled: false, url: '', anonKey: '' } };

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
  emptyState: document.getElementById('emptyState')
};

const app = {
  config: DEFAULT_CONFIG,
  supabase: null,
  session: null,
  currentTab: 'active',
  leads: [],
  lastUpdated: '',
  state: {},
  sourceOptions: [],
  remoteLeadIds: new Set(),
  authPanelOpen: false,
  inbox: [],
  inboxAccount: '',
  inboxLive: false,
  inboxImported: new Set()
};

function showNotice(message, kind = 'info') {
  els.notice.hidden = !message;
  if (!message) return;
  els.notice.textContent = message;
  els.notice.style.background = kind === 'error' ? '#fef2f2' : '#fff7ed';
  els.notice.style.color = kind === 'error' ? '#991b1b' : '#9a3412';
  els.notice.style.borderColor = kind === 'error' ? '#fecaca' : '#fed7aa';
}

function setSyncStatus(message) {
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

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  els.showAuthBtn.textContent = app.authPanelOpen ? 'Hide sync settings' : 'Sync settings';
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

async function loadLeads() {
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
  } catch (error) {
    if (Array.isArray(imported?.leads) && imported.leads.length) {
      app.leads = imported.leads;
      app.lastUpdated = imported.last_updated || '';
    } else {
      throw error;
    }
  }

  app.remoteLeadIds = new Set();
  if (app.supabase && app.session) {
    const { data, error } = await app.supabase.from('leads').select('id');
    if (!error && Array.isArray(data)) {
      app.remoteLeadIds = new Set(data.map((row) => Number(row.id)));
    }
  }
}

async function loadInbox() {
  try {
    const response = await fetch(`/api/inbox?t=${Date.now()}`, { cache: 'no-store' });
    if (response.ok) {
      const json = await response.json();
      if (json.configured && Array.isArray(json.emails)) {
        app.inbox = json.emails;
        app.inboxAccount = json.inbox_account || json.account || 'Inbox';
        app.inboxAccounts = json.inbox_accounts || [app.inboxAccount];
        app.inboxLive = true;
      } else {
        app.inbox = [];
        app.inboxLive = false;
      }
    } else {
      app.inbox = [];
      app.inboxLive = false;
    }
  } catch {
    app.inbox = [];
    app.inboxLive = false;
  }

  const stored = JSON.parse(localStorage.getItem(INBOX_IMPORTED_KEY) || '[]');
  app.inboxImported = new Set(Array.isArray(stored) ? stored : []);
}

function persistInboxImported() {
  localStorage.setItem(INBOX_IMPORTED_KEY, JSON.stringify([...app.inboxImported]));
}

function inboxAvatarInitials(name) {
  return String(name || '?').split(' ').map((w) => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
}

function renderInboxEmail(email) {
  const initials = escapeHtml(inboxAvatarInitials(email.from_name));
  const date = formatDateTime(email.received_at);
  const urgentClass = String(email.priority || '').toUpperCase() === 'URGENT' ? ' inbox-urgent' : '';
  const priorityClass = pillClass(email.priority);
  const priorityVal = String(email.priority || 'Medium');
  const priorityLabel = priorityVal.charAt(0).toUpperCase() + priorityVal.slice(1).toLowerCase();
  return `<div class="inbox-card${urgentClass}">
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
      <span class="inbox-meta-pill">${escapeHtml(email.source_label || 'Email')}</span>
    </div>
    <div class="actions">
      <button class="btn-import" type="button" data-import-id="${escapeHtml(String(email.id))}">&#x2192; Import as Lead</button>
    </div>
  </div>`;
}

function renderInbox() {
  if (!app.inboxLive && !app.inbox.length) {
    els.list.innerHTML = '<div class="inbox-empty">Inbox not configured. Set JGMS_EMAIL + Azure credentials, FLA_EMAIL + FLA_IMAP_PASSWORD, or NTRRLS_EMAIL + NTRRLS_IMAP_PASSWORD in Vercel environment variables to enable live inbox.</div>';
    els.emptyState.hidden = true;
    return;
  }
  const pending = app.inbox.filter((e) => !app.inboxImported.has(e.id));
  if (!pending.length) {
    els.list.innerHTML = '<div class="inbox-empty">No new messages in the inbox.</div>';
    els.emptyState.hidden = true;
    return;
  }
  const accounts = (app.inboxAccounts && app.inboxAccounts.length) ? app.inboxAccounts : [app.inboxAccount || 'Inbox'];
  const accountLabel = accounts.join(', ');
  els.list.innerHTML = `<div class="inbox-header">Live inbox &mdash; <strong>${escapeHtml(accountLabel)}</strong> &mdash; ${pending.length} message${pending.length !== 1 ? 's' : ''}. Click <em>Import as Lead</em> to move any email into the tracker.</div>` +
    pending.map(renderInboxEmail).join('');
  els.emptyState.hidden = true;
}

function importInboxEmail(emailId) {
  const email = app.inbox.find((e) => String(e.id) === String(emailId));
  if (!email) return;
  app.inboxImported.add(email.id);
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
    notes: email.body_preview || email.snippet || '',
    raw_preview: email.snippet || '',
    next_action: email.next_action || 'Reply to email',
    location: email.location || 'Unknown',
    opposing_party: email.opposing_party || 'Unknown'
  };
  app.leads.unshift(lead);
  app.currentTab = 'active';
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'active'));
  render();
  showNotice(`${email.from_name} imported to Active leads.`, 'info');
}

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

function buildSourceLabel(source) {
  const map = {
    'jacquigriffin@mobilesolicitor.com.au': 'JGMS',
    'hello@ntruralremotelegalservices.com.au': 'NTRRLS',
    'Finchly/LawConnect': 'Finchly/LawConnect',
    'SMS': 'SMS Forward'
  };
  return map[source] || source || 'Unknown';
}

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
  if (source === 'jacquigriffin@mobilesolicitor.com.au') return 'source-jgms';
  if (source === 'hello@ntruralremotelegalservices.com.au') return 'source-ntr';
  if (source === 'Finchly/LawConnect') return 'source-fla';
  return '';
}

function inferType(lead) {
  const matter = String(lead.matter_type || '');
  if (/care|child/i.test(matter)) return 'Care and Protection';
  if (/violence/i.test(matter)) return 'Domestic Violence';
  if (/family/i.test(matter)) return 'Family Law';
  return matter || 'Other';
}

function renderLead(lead, index) {
  const id = getLeadId(lead, index);
  const state = getLeadState(id);
  const source = lead.source_account || lead.source_platform || 'Unknown';
  const sourceLabel = buildSourceLabel(source);
  const phone = lead.sender_phone || lead.phone || (source === 'SMS' ? 'Check SMS app' : 'Unknown');
  const email = lead.sender_email || 'Unknown';
  const summary = lead.raw_preview || lead.notes || '';
  const date = formatLeadDate(lead.date_received);
  const rowClass = `${leadUrgencyClass(lead.priority)} ${state.actioned ? 'actioned-row' : ''}`.trim();
  const typeLabel = inferType(lead);
  const subject = lead.subject || '';
  const location = lead.location || 'Unknown';
  const opposing = lead.opposing_party || 'Unknown';
  const nextAction = lead.next_action || (state.actioned ? 'Completed' : 'Follow up');
  const priorityValue = String(lead.priority || 'LOW').toUpperCase();
  const priorityLabel = priorityValue.charAt(0) + priorityValue.slice(1).toLowerCase();
  const callAction = phone && phone !== 'Unknown' && phone !== 'Check SMS app'
    ? `<a class="btn-call" href="tel:${escapeHtml(phone)}">&#128222; Call</a>`
    : '';
  const smsDraft = `Hi ${lead.sender_name || ''}, it's Jacqui Griffin. Thanks for reaching out. I'll review your enquiry and get back to you shortly.`.trim();
  const smsAction = phone && phone !== 'Unknown' && phone !== 'Check SMS app'
    ? `<a class="btn-sms" href="sms:${escapeHtml(phone)}?body=${encodeURIComponent(smsDraft)}">&#128172; SMS</a>`
    : '';
  const emailAction = email !== 'Unknown'
    ? `<a class="btn-email" href="mailto:${escapeHtml(email)}?subject=${encodeURIComponent(subject)}">&#9993;&#65039; Email</a>`
    : '';
  const deleteAction = `<button class="btn btn-danger" type="button" data-delete-id="${escapeHtml(id)}">Delete lead</button>`;
  const actionMarkup = `<div class="actions">${callAction}${smsAction}${emailAction}${deleteAction}</div>`;

  return `<div class="row ${rowClass}" data-id="${escapeHtml(id)}" data-source="${escapeHtml(source)}" data-date="${escapeHtml(date)}" data-urgency="${escapeHtml(priorityValue)}">
    <div class="top">
      <div class="lead-heading">
        <div class="name">${escapeHtml(lead.sender_name || 'Unknown')}</div>
        <div class="meta"><span>${escapeHtml(date)}</span><span class="meta-sep">•</span><span>${escapeHtml(sourceLabel)}</span></div>
      </div>
      <div class="pill ${pillClass(lead.priority)} priority-pill">${escapeHtml(priorityLabel)}</div>
    </div>
    <div class="pill-row"><span class="pill ${sourcePillClass(source)}">${escapeHtml(sourceLabel)}</span><span class="pill type-pill">${escapeHtml(typeLabel)}</span></div>
    <div class="grid">
      <div class="field"><strong>Matter Type</strong>${escapeHtml(lead.matter_type || 'Unknown')}</div>
      <div class="field"><strong>Location</strong>${escapeHtml(location)}</div>
      <div class="field"><strong>Opposing Party</strong>${escapeHtml(opposing)}</div>
      <div class="field"><strong>Next Action</strong>${escapeHtml(nextAction)}</div>
    </div>
    <div class="grid">
      <div class="field"><strong>Email</strong>${email !== 'Unknown' ? `<a class="contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '<span class="unknown">Unknown</span>'}</div>
      <div class="field"><strong>Phone</strong>${phone && phone !== 'Unknown' && phone !== 'Check SMS app' ? `<a class="contact-link" href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : `<span class="unknown">${escapeHtml(phone || 'Unknown')}</span>`}</div>
    </div>
    ${actionMarkup}
    <div class="field summary-field"><strong>Summary</strong>${escapeHtml(summary)}</div>
    <div class="leap-row">
      <div class="leap-item actioned-item"><input type="checkbox" data-flag="actioned" data-id="${escapeHtml(id)}" ${state.actioned ? 'checked' : ''}><label>✅ Actioned</label></div>
      <div class="leap-item"><input type="checkbox" data-flag="leap" data-id="${escapeHtml(id)}" ${state.leap ? 'checked' : ''}><label>LEAP Client</label></div>
      <div class="leap-item"><input type="checkbox" data-flag="noAction" data-id="${escapeHtml(id)}" ${state.noAction ? 'checked' : ''}><label>No Action</label></div>
      <div class="leap-item"><input type="checkbox" data-flag="laAccepted" data-id="${escapeHtml(id)}" ${state.laAccepted ? 'checked' : ''}><label>LA</label></div>
    </div>
    <div class="comment-wrap"><strong>Comment</strong><textarea class="comment-box" data-comment-id="${escapeHtml(id)}" placeholder="Add a comment...">${escapeHtml(state.comment || '')}</textarea></div>
  </div>`;
}

function updateSummary() {
  const visibleLeads = getVisibleLeads();
  const dates = visibleLeads.map((lead) => parseLeadDate(lead.date_received)).filter(Boolean).sort((a, b) => a - b);
  els.heroSub.textContent = dates.length ? `All leads | Date range: ${formatLeadDate(dates[0])} to ${formatLeadDate(dates[dates.length - 1])}` : 'No leads loaded';
  els.lastUpdatedLine.textContent = `Last updated: ${formatDateTime(app.lastUpdated)}`;
  els.updateNowLink.href = `./?update=${Date.now()}`;
}

function updateSourceFilter() {
  const visibleLeads = getVisibleLeads();
  const sources = Array.from(new Set(visibleLeads.map((lead) => lead.source_account || lead.source_platform || 'Unknown')));
  const current = els.sourceFilter.value || 'all';
  els.sourceFilter.innerHTML = '<option value="all">All sources</option>' + sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(buildSourceLabel(source))} (${escapeHtml(source)})</option>`).join('');
  els.sourceFilter.value = sources.includes(current) ? current : 'all';
}

function updateTabCounts() {
  const visibleLeads = getVisibleLeads();
  const active = visibleLeads.filter((lead) => !getLeadState(getLeadId(lead, app.leads.indexOf(lead))).actioned).length;
  const actioned = visibleLeads.length - active;
  const unread = app.inbox.filter((e) => !app.inboxImported.has(e.id)).length;
  const tabs = document.querySelectorAll('.tab');
  if (tabs[0]) tabs[0].innerHTML = `Active <span class="actioned-count">${active}</span>`;
  if (tabs[1]) tabs[1].innerHTML = `Actioned <span class="actioned-count">${actioned}</span>`;
  if (tabs[2]) tabs[2].innerHTML = `Inbox <span class="actioned-count">${unread}</span>`;
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
}

function render() {
  if (app.currentTab === 'inbox') {
    renderInbox();
    updateTabCounts();
    return;
  }
  const visibleLeads = getVisibleLeads();
  if (!visibleLeads.length) {
    els.list.innerHTML = '<div class="empty">No leads available.</div>';
    updateSummary();
    updateTabCounts();
    filterRows();
    return;
  }
  els.list.innerHTML = visibleLeads.map((lead) => renderLead(lead, app.leads.indexOf(lead))).join('');
  updateSummary();
  updateSourceFilter();
  updateTabCounts();
  filterRows();
}

async function hydrate() {
  setSyncStatus('Loading…');
  loadLocalState();
  await loadLeads();
  await loadInbox();
  migrateLegacyState();
  if (app.supabase && app.session) {
    await loadSupabaseState();
    await syncAllMeaningfulStateRemote();
  }
  render();
  setDefaultSyncStatus();
}

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
  setLeadState(leadId, { hidden: true });
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

function attachEvents() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      app.currentTab = button.dataset.tab;
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
      render();
    });
  });
  [els.search, els.sourceFilter, els.dateFilter, els.urgencyFilter].forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', filterRows));
  els.list.addEventListener('change', (event) => {
    if (event.target.matches('input[type="checkbox"][data-flag]')) handleStateChange(event.target);
    if (event.target.matches('textarea[data-comment-id]')) handleCommentChange(event.target);
  });
  els.list.addEventListener('input', (event) => {
    if (event.target.matches('textarea[data-comment-id]')) handleCommentChange(event.target);
  });
  els.list.addEventListener('click', (event) => {
    if (event.target.matches('button[data-delete-id]')) handleDeleteLead(event.target);
    if (event.target.matches('button[data-import-id]')) importInboxEmail(event.target.dataset.importId);
  });

  els.updateNowLink.addEventListener('click', () => {
    try {
      localStorage.removeItem('xena-leads-data-import');
    } catch {}
  });

  els.showAuthBtn.addEventListener('click', () => {
    app.authPanelOpen = !app.authPanelOpen;
    refreshAuthUi();
    if (app.authPanelOpen && !app.session) els.authEmail.focus();
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
      const { error } = await app.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
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
      app.authPanelOpen = false;
      showNotice('Signed out.', 'info');
      refreshAuthUi();
      await hydrate();
    } catch (error) {
      handleError(error);
    }
  });
}

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

async function start() {
  attachEvents();
  await loadConfig();
  await initSupabase();
  await hydrate();
}

start().catch(handleError);
