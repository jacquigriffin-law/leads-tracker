'use strict';

const { verifyPinSession } = require('./lib/pin-session');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const TODO_LIST_NAME = 'Leads & Intake';
const MARKER_PREFIX = '[leadflow:';
const IMPORT_MARKER_PREFIX = '[leadflow-todo-sync:';
const TRACKED_STATUSES = new Set([
  'new',
  'follow_up',
  'contacted',
  'awaiting_reply',
  'awaiting_documents',
  'awaiting_legal_aid',
  'ready_for_leap',
]);

function audit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...details }));
}

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function sanitiseText(value, max = 4000) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function stripHtml(text) {
  return sanitiseText(text, 20000)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function leadMarker(leadId) {
  return `${MARKER_PREFIX}${leadId}]`;
}

function importMarker(task) {
  return `${IMPORT_MARKER_PREFIX}${task.id}:${task.lastModifiedDateTime || 'unknown'}]`;
}

function statusLabel(status) {
  return String(status || 'new')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getEffectiveStatus(lead, state) {
  return sanitiseText(state?.prospective_status || state?.prospectiveStatus || lead?.status || 'new', 64).toLowerCase();
}

function shouldSyncLead(lead, state) {
  return TRACKED_STATUSES.has(getEffectiveStatus(lead, state));
}

function getGraphEnv() {
  return {
    clientId: process.env.AZURE_CLIENT_ID || process.env.MS365_CLIENT_ID || '',
    tenantId: process.env.AZURE_TENANT_ID || process.env.MS365_TENANT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || process.env.MS365_CLIENT_SECRET || '',
    primaryUser: (process.env.MS365_PRIMARY_USER || 'jacquigriffin@mobilesolicitor.com.au').toLowerCase(),
  };
}

function isGraphConfigured() {
  const env = getGraphEnv();
  return Boolean(env.clientId && env.tenantId && env.clientSecret && env.primaryUser);
}

async function getGraphToken() {
  const env = getGraphEnv();
  if (!isGraphConfigured()) {
    const error = new Error('Microsoft To Do sync is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const body = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Microsoft Graph auth failed ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function graphFetch(token, endpoint, options = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : `${GRAPH_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (response.status === 204) return { ok: true };
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Microsoft Graph ${options.method || 'GET'} failed ${response.status}: ${text.slice(0, 200)}`);
  }
  const json = text ? JSON.parse(text) : {};
  return json;
}

async function getUserId(token) {
  const env = getGraphEnv();
  const encoded = env.primaryUser.replace(/'/g, "''");
  const data = await graphFetch(
    token,
    `/users?$filter=mail eq '${encoded}' or userPrincipalName eq '${encoded}'&$select=id,displayName,mail,userPrincipalName`,
  );
  const user = data?.value?.[0];
  if (!user?.id) throw new Error(`Could not resolve Microsoft 365 user ${env.primaryUser}.`);
  return user.id;
}

async function getTodoList(token, userId, listName = TODO_LIST_NAME) {
  const data = await graphFetch(token, `/users/${userId}/todo/lists?$top=100`);
  const list = (data.value || []).find((item) => String(item.displayName || '').trim().toLowerCase() === listName.toLowerCase());
  if (!list?.id) {
    const error = new Error(`Microsoft To Do list '${listName}' was not found.`);
    error.statusCode = 503;
    throw error;
  }
  return list;
}

async function getAllTasks(token, userId, listId) {
  const tasks = [];
  let endpoint = `/users/${userId}/todo/lists/${listId}/tasks?$top=200`;
  while (endpoint) {
    const data = await graphFetch(token, endpoint);
    tasks.push(...(data.value || []));
    endpoint = data['@odata.nextLink'] || '';
  }
  return tasks;
}

function findTaskForLead(tasks, leadId) {
  const marker = leadMarker(leadId);
  return tasks.find((task) => {
    const body = stripHtml(task.body?.content || '');
    return String(task.title || '').includes(marker) || body.includes(marker);
  }) || null;
}

function buildTaskTitle(lead, state) {
  const status = statusLabel(getEffectiveStatus(lead, state));
  const name = sanitiseText(lead.sender_name || 'Unknown lead', 120);
  const subject = sanitiseText(lead.subject || lead.matter_type || '', 100);
  const title = subject ? `LeadFlow: ${name} - ${subject}` : `LeadFlow: ${name}`;
  return `${title}`.slice(0, 240).replace(/\s+/g, ' ').trim();
}

function buildTaskBody(lead, state) {
  const leadId = sanitiseText(lead.id, 80);
  const lines = [
    leadMarker(leadId),
    `LeadFlow status: ${statusLabel(getEffectiveStatus(lead, state))}`,
    `Lead: ${sanitiseText(lead.sender_name || 'Unknown')}`,
  ];
  if (lead.sender_phone) lines.push(`Phone: ${sanitiseText(lead.sender_phone, 120)}`);
  if (lead.sender_email) lines.push(`Email: ${sanitiseText(lead.sender_email, 160)}`);
  if (lead.subject) lines.push(`Subject: ${sanitiseText(lead.subject, 240)}`);
  if (lead.matter_type) lines.push(`Matter type: ${sanitiseText(lead.matter_type, 120)}`);
  if (lead.location) lines.push(`Location: ${sanitiseText(lead.location, 120)}`);
  if (lead.opposing_party) lines.push(`Opposing party: ${sanitiseText(lead.opposing_party, 160)}`);
  if (state?.follow_up_date || state?.followUpDate) lines.push(`Follow-up due: ${sanitiseText(state.follow_up_date || state.followUpDate, 40)}`);
  if (lead.next_action) lines.push(`Next action: ${sanitiseText(lead.next_action, 400)}`);
  if (state?.comment) lines.push('', 'LeadFlow notes:', sanitiseText(state.comment, 4000));
  if (lead.notes && !state?.comment) lines.push('', 'Lead notes:', sanitiseText(lead.notes, 4000));
  return lines.join('\n');
}

function buildTaskPayload(lead, state) {
  const payload = {
    title: buildTaskTitle(lead, state),
    body: { contentType: 'text', content: buildTaskBody(lead, state) },
    importance: String(lead.priority || '').toUpperCase() === 'URGENT' ? 'high' : 'normal',
  };
  const due = sanitiseText(state?.follow_up_date || state?.followUpDate, 32);
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    payload.dueDateTime = { dateTime: `${due}T17:00:00`, timeZone: 'AUS Eastern Standard Time' };
  }
  return payload;
}

async function upsertLeadTask({ token, userId, listId, lead, state }) {
  if (!lead?.id) {
    const error = new Error('lead.id is required');
    error.statusCode = 400;
    throw error;
  }
  if (!shouldSyncLead(lead, state)) {
    return { ok: true, configured: true, skipped: true, reason: 'Lead status is not tracked for To Do sync.' };
  }
  const tasks = await getAllTasks(token, userId, listId);
  const existing = findTaskForLead(tasks, lead.id);
  const payload = buildTaskPayload(lead, state);
  if (existing?.id) {
    const task = await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return { ok: true, configured: true, action: 'updated', task };
  }
  const task = await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { ok: true, configured: true, action: 'created', task };
}

async function supabaseFetch(path, options = {}) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  const supabaseUrl = process.env.SUPABASE_URL || 'https://lviislwimdvxuuvmvzfn.supabase.co';
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(options.headers || {}),
    },
  });
}

async function loadLeads() {
  const response = await supabaseFetch('leads?select=id,sender_name,sender_email,sender_phone,subject,matter_type,priority,status,notes,location,opposing_party,next_action&order=date_received.desc');
  if (!response.ok) throw new Error(`Supabase leads read failed ${response.status}`);
  return response.json();
}

async function loadStates() {
  const response = await supabaseFetch('lead_states?select=lead_id,user_id,actioned,leap,no_action,la_accepted,comment');
  if (!response.ok) throw new Error(`Supabase state read failed ${response.status}`);
  return response.json();
}

async function resolveStateUserId(leadId, states) {
  if (process.env.LEADFLOW_PIN_USER_ID) return process.env.LEADFLOW_PIN_USER_ID;
  const existing = (states || []).find((state) => String(state.lead_id) === String(leadId) && state.user_id);
  if (existing?.user_id) return existing.user_id;
  const any = (states || []).find((state) => state.user_id);
  return any?.user_id || null;
}

async function saveComment(leadId, comment, states) {
  const userId = await resolveStateUserId(leadId, states);
  if (!userId) {
    const error = new Error('Lead state user is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const existing = (states || []).find((state) => String(state.lead_id) === String(leadId)) || {};
  const payload = {
    lead_id: Number(leadId),
    user_id: userId,
    actioned: Boolean(existing.actioned),
    leap: Boolean(existing.leap),
    no_action: Boolean(existing.no_action),
    la_accepted: Boolean(existing.la_accepted),
    comment,
  };
  const response = await supabaseFetch('lead_states?on_conflict=user_id,lead_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Supabase comment write failed ${response.status}`);
  return response.json();
}

function buildImportedNote(task) {
  const body = stripHtml(task.body?.content || '');
  return [
    importMarker(task),
    `Microsoft To Do update (${task.lastModifiedDateTime || 'unknown time'})`,
    `Task status: ${statusLabel(task.status || 'unknown')}`,
    body,
  ].filter(Boolean).join('\n');
}

async function pullTodoUpdates({ token, userId, listId }) {
  const [leads, states, tasks] = await Promise.all([loadLeads(), loadStates(), getAllTasks(token, userId, listId)]);
  const stateByLeadId = new Map((states || []).map((state) => [String(state.lead_id), state]));
  const results = [];

  for (const lead of leads || []) {
    const task = findTaskForLead(tasks, lead.id);
    if (!task) continue;
    const state = stateByLeadId.get(String(lead.id)) || {};
    const marker = importMarker(task);
    const currentComment = sanitiseText(state.comment || '', 10000);
    if (currentComment.includes(marker)) {
      results.push({ lead_id: lead.id, task_id: task.id, action: 'skipped', reason: 'already imported' });
      continue;
    }
    const nextComment = [currentComment, buildImportedNote(task)].filter(Boolean).join('\n\n---\n\n').slice(0, 10000);
    await saveComment(lead.id, nextComment, states);
    results.push({ lead_id: lead.id, task_id: task.id, action: 'comment_appended' });
  }

  return { ok: true, configured: true, results };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization, Cookie');

  if (!['POST'].includes(req.method)) {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const ip = clientIp(req);
  const claims = verifyPinSession(req);
  if (!claims) {
    audit('todo_sync.auth_failed', { ip });
    return res.status(401).json({ error: 'Authentication required.' });
  }

  let body = {};
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  if (!isGraphConfigured()) {
    return res.status(200).json({ ok: true, configured: false, skipped: true, reason: 'Microsoft To Do sync is not configured.' });
  }

  try {
    const token = await getGraphToken();
    const userId = await getUserId(token);
    const list = await getTodoList(token, userId, TODO_LIST_NAME);
    const action = body.action || 'sync-lead';

    if (action === 'pull-task-notes') {
      const result = await pullTodoUpdates({ token, userId, listId: list.id });
      audit('todo_sync.pull_ok', { ip, user: claims.email || 'pin-session', count: result.results.length });
      return res.status(200).json(result);
    }

    const result = await upsertLeadTask({ token, userId, listId: list.id, lead: body.lead || {}, state: body.state || {} });
    audit('todo_sync.upsert_ok', { ip, user: claims.email || 'pin-session', action: result.action || 'skipped', lead_id: body.lead?.id || null });
    return res.status(200).json(result);
  } catch (error) {
    const status = error.statusCode || 500;
    audit('todo_sync.error', { ip, user: claims.email || 'pin-session', error: error?.message || 'unknown' });
    return res.status(status).json({ error: status === 503 ? error.message : 'Microsoft To Do sync failed.' });
  }
};

module.exports._test = {
  TODO_LIST_NAME,
  TRACKED_STATUSES,
  buildTaskBody,
  buildTaskPayload,
  findTaskForLead,
  getEffectiveStatus,
  leadMarker,
  shouldSyncLead,
  stripHtml,
};
