'use strict';

const { createHash } = require('crypto');
const { verifyPinSession } = require('./lib/pin-session');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const TODO_LIST_NAME = 'Leads & Intake';
const MARKER_PREFIX = '[leadflow:';
const IMPORT_MARKER_PREFIX = '[leadflow-todo-sync:';
const TRIAGE_MARKER_PREFIX = '[leadflow-triage:';
const TRIAGE_PAYLOAD_PREFIX = 'XENA_TRIAGE_PAYLOAD:';
const TRIAGE_DECISIONS = [
  'CALL FIRST',
  'YES - prospective lead',
  'NO - not a lead',
  'EXISTING MATTER',
  'DUPLICATE',
];
const TRIAGE_STATUS_BY_DECISION = {
  'YES - prospective lead': 'new',
  'NO - not a lead': 'not_a_lead',
  'EXISTING MATTER': 'existing_matter',
  DUPLICATE: 'closed',
  'CALL FIRST': 'follow_up',
};
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

function triageMarker(emailId) {
  return `${TRIAGE_MARKER_PREFIX}${sanitiseText(emailId, 160)}]`;
}

function triageLeadMarker(emailId) {
  return `[leadflow-triage-lead:${sanitiseText(emailId, 160)}]`;
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

async function getChecklistItems(token, userId, listId, taskId) {
  const data = await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${taskId}/checklistItems?$top=50`);
  return data.value || [];
}

async function ensureDecisionChecklist(token, userId, listId, taskId) {
  const existing = await getChecklistItems(token, userId, listId, taskId);
  const expectedNames = new Set(TRIAGE_DECISIONS.map((decision) => decision.toLowerCase()));
  const keptNames = new Set();
  for (const item of existing) {
    const name = String(item.displayName || '').trim().toLowerCase();
    if (!expectedNames.has(name) || keptNames.has(name)) {
      await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${taskId}/checklistItems/${item.id}`, {
        method: 'DELETE',
      });
      continue;
    }
    keptNames.add(name);
  }
  for (const decision of TRIAGE_DECISIONS) {
    if (keptNames.has(decision.toLowerCase())) continue;
    await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${taskId}/checklistItems`, {
      method: 'POST',
      body: JSON.stringify({ displayName: decision }),
    });
  }
}

function findTaskForLead(tasks, leadId) {
  const marker = leadMarker(leadId);
  return tasks.find((task) => {
    const body = stripHtml(task.body?.content || '');
    return String(task.title || '').includes(marker) || body.includes(marker);
  }) || null;
}

function findTaskForTriage(tasks, emailId) {
  const marker = triageMarker(emailId);
  return tasks.find((task) => {
    const body = stripHtml(task.body?.content || '');
    return String(task.title || '').includes(marker) || body.includes(marker);
  }) || null;
}

function findConvertedTriageTask(tasks, emailId) {
  const sourceLine = `LeadFlow source inbox id: ${sanitiseText(emailId, 160)}`;
  return tasks.find((task) => stripHtml(task.body?.content || '').includes(sourceLine)) || null;
}

function encodeTriagePayload(email) {
  const payload = {
    id: sanitiseText(email.id, 120),
    from_name: sanitiseText(email.from_name, 200),
    from_email: sanitiseText(email.from_email, 240),
    phone: sanitiseText(email.phone, 80),
    subject: sanitiseText(email.subject, 240),
    received_at: sanitiseText(email.received_at, 80),
    snippet: sanitiseText(email.snippet, 500),
    source_label: sanitiseText(email.source_label || email.source_account, 80),
    source_account: sanitiseText(email.source_account || email.source_label, 80),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeTriagePayload(task) {
  const body = stripHtml(task.body?.content || '');
  const line = body.split(/\r?\n/).find((item) => item.startsWith(TRIAGE_PAYLOAD_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(Buffer.from(line.slice(TRIAGE_PAYLOAD_PREFIX.length).trim(), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getTriageIdFromTask(task) {
  const text = `${task.title || ''}\n${stripHtml(task.body?.content || '')}`;
  const match = text.match(/\[leadflow-triage:([^\]]+)\]/);
  return match ? match[1] : '';
}

function getLeadIdFromTask(task) {
  const text = `${task.title || ''}\n${stripHtml(task.body?.content || '')}`;
  const match = text.match(/\[leadflow:([^\]]+)\]/);
  return match ? match[1] : '';
}

function buildTriageTaskTitle(email) {
  const source = sanitiseText(email.source_label || email.source_account || 'Inbox', 40);
  const subject = sanitiseText(email.subject || 'possible lead', 90);
  const name = sanitiseText(email.from_name || email.from_email || 'Unknown', 80);
  return `TRIAGE - ${source} - ${subject} - ${name}`.replace(/\s+/g, ' ').slice(0, 240);
}

function buildTriageTaskBody(email) {
  const emailId = sanitiseText(email.id, 120);
  const lines = [
    triageMarker(emailId),
    'LeadFlow triage candidate',
    `Source: ${sanitiseText(email.source_label || email.source_account || 'Inbox', 80)}`,
    `From: ${sanitiseText(email.from_name || 'Unknown', 200)}`,
  ];
  if (email.from_email) lines.push(`Email: ${sanitiseText(email.from_email, 240)}`);
  if (email.phone) lines.push(`Phone: ${sanitiseText(email.phone, 80)}`);
  if (email.subject) lines.push(`Subject: ${sanitiseText(email.subject, 240)}`);
  if (email.received_at) lines.push(`Received: ${sanitiseText(email.received_at, 80)}`);
  if (email.snippet) lines.push('', 'Safe preview:', sanitiseText(email.snippet, 500));
  lines.push(
    '',
    'Tick exactly one checklist decision. Xena will sync that decision back to LeadFlow.',
    '',
    `${TRIAGE_PAYLOAD_PREFIX} ${encodeTriagePayload(email)}`,
  );
  return lines.join('\n');
}

function buildTriageTaskPayload(email) {
  // Standing rule (Jacqui, 7 Jul 2026): never mark LeadFlow-created tasks as
  // Important or add to My Day by default. Use normal importance so Jacqui's
  // starred list stays reserved for genuine human-important work.
  return {
    title: buildTriageTaskTitle(email),
    body: { contentType: 'text', content: buildTriageTaskBody(email) },
    importance: 'normal',
  };
}

function isDecisionChecked(item) {
  return item.isChecked === true || item.checkedDateTime || String(item.status || '').toLowerCase() === 'completed';
}

function getCheckedDecision(checklistItems) {
  const checked = (checklistItems || [])
    .filter((item) => TRIAGE_DECISIONS.includes(String(item.displayName || '').trim()) && isDecisionChecked(item))
    .map((item) => String(item.displayName || '').trim());
  if (!checked.length) return null;
  if (checked.length > 1) return { decision: null, multiple: true, checked };
  return { decision: checked[0], multiple: false, checked };
}

function decisionToLeadStatus(decision) {
  return TRIAGE_STATUS_BY_DECISION[decision] || 'new';
}

function decisionCreatesFollowUp(decision) {
  return decision === 'YES - prospective lead' || decision === 'CALL FIRST';
}

function leadRecordFromTriage(email, decision, id) {
  const status = decisionToLeadStatus(decision);
  const marker = triageLeadMarker(email.id);
  return {
    id,
    sender_name: sanitiseText(email.from_name || email.from_email || 'Unknown lead', 200) || 'Unknown lead',
    sender_email: sanitiseText(email.from_email, 240),
    sender_phone: sanitiseText(email.phone, 80),
    source_account: sanitiseText(email.source_account || email.source_label || 'LeadFlow Inbox', 120),
    source_platform: 'To Do triage',
    source_rule: `${marker} Microsoft To Do decision: ${decision}`,
    subject: sanitiseText(email.subject || 'Inbox lead triage', 240),
    date_received: sanitiseText(email.received_at, 80) || new Date().toISOString(),
    priority: decision === 'CALL FIRST' ? 'HIGH' : 'MEDIUM',
    status,
    raw_preview: sanitiseText(email.snippet, 1000),
    notes: [
      marker,
      `Triage decision from Microsoft To Do: ${decision}`,
      email.snippet ? `Safe preview: ${sanitiseText(email.snippet, 500)}` : '',
    ].filter(Boolean).join('\n'),
    next_action: decisionCreatesFollowUp(decision) ? (decision === 'CALL FIRST' ? 'Call first before classifying.' : 'Follow up as prospective lead.') : null,
  };
}

async function syncInboxTriage({ token, userId, listId, candidates }) {
  const safeCandidates = Array.isArray(candidates) ? candidates.slice(0, 100).filter((email) => email?.id) : [];
  const tasks = await getAllTasks(token, userId, listId);
  const results = [];

  for (const email of safeCandidates) {
    const existing = findTaskForTriage(tasks, email.id);
    const converted = findConvertedTriageTask(tasks, email.id);
    if (!existing && converted?.id) {
      results.push({ inbox_id: String(email.id), task_id: converted.id, action: 'skipped', reason: 'already_converted_to_follow_up' });
      continue;
    }
    const payload = buildTriageTaskPayload(email);
    let task;
    let action;
    if (existing?.id) {
      task = await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      action = 'updated';
    } else {
      task = await graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      tasks.push(task);
      action = 'created';
    }
    await ensureDecisionChecklist(token, userId, listId, task.id);
    results.push({ inbox_id: String(email.id), task_id: task.id, action });
  }

  return { ok: true, configured: true, list: TODO_LIST_NAME, results };
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
  // Standing rule (Jacqui, 7 Jul 2026): do not set Microsoft To Do
  // importance=high or add to My Day by default from LeadFlow. Jacqui reserves
  // the Important flag for genuine human-important work. Priority in LeadFlow
  // remains the source of truth for prioritisation; the To Do task carries a
  // real due date only when there is an actual follow-up deadline.
  const payload = {
    title: buildTaskTitle(lead, state),
    body: { contentType: 'text', content: buildTaskBody(lead, state) },
    importance: 'normal',
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

function buildAcceptedTriageTaskPayload({ lead, state, originalTask }) {
  const originalBody = stripHtml(originalTask?.body?.content || '');
  const triageId = getTriageIdFromTask(originalTask);
  const sourceLines = [];
  if (triageId) sourceLines.push(`LeadFlow source inbox id: ${sanitiseText(triageId, 160)}`);
  sourceLines.push(`Converted from To Do decision: ${sanitiseText(state?.decision || 'YES - prospective lead', 80)}`);
  if (originalTask?.id) sourceLines.push(`Original To Do task: ${sanitiseText(originalTask.id, 120)}`);
  if (originalBody) {
    const withoutPayload = originalBody
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(TRIAGE_PAYLOAD_PREFIX) && !line.startsWith(TRIAGE_MARKER_PREFIX))
      .join('\n')
      .trim();
    if (withoutPayload) sourceLines.push('', 'Original triage note:', sanitiseText(withoutPayload, 4000));
  }

  const mergedState = {
    ...state,
    comment: [sanitiseText(state?.comment || '', 2000), ...sourceLines]
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000),
  };
  const payload = buildTaskPayload(lead, mergedState);
  payload.status = 'notStarted';
  payload.importance = 'normal';
  return payload;
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
  const response = await supabaseFetch('leads?select=id,source_account,date_received,sender_name,sender_email,sender_phone,subject,source_rule,source_platform,matter_type,priority,status,notes,raw_preview,location,opposing_party,next_action&order=date_received.desc');
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

function triageCoreFlags(decision) {
  if (decision === 'NO - not a lead' || decision === 'EXISTING MATTER' || decision === 'DUPLICATE') {
    return { actioned: true, leap: false, no_action: true, la_accepted: false };
  }
  return { actioned: false, leap: false, no_action: false, la_accepted: false };
}

async function saveTriageState(leadId, decision, task, states) {
  const userId = await resolveStateUserId(leadId, states);
  if (!userId) {
    const error = new Error('Lead state user is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const existing = (states || []).find((state) => String(state.lead_id) === String(leadId)) || {};
  const marker = `[leadflow-triage-decision:${task.id}:${decision}]`;
  const currentComment = sanitiseText(existing.comment || '', 10000);
  const note = [
    marker,
    `Microsoft To Do triage decision: ${decision}`,
    `LeadFlow status stored: ${decisionToLeadStatus(decision)}`,
    `Microsoft To Do task retained as follow-up: ${task.title || task.id}`,
  ].join('\n');
  const flags = triageCoreFlags(decision);
  const payload = {
    lead_id: Number(leadId),
    user_id: userId,
    ...flags,
    comment: currentComment.includes(marker)
      ? currentComment
      : [currentComment, note].filter(Boolean).join('\n\n---\n\n').slice(0, 10000),
  };
  const response = await supabaseFetch('lead_states?on_conflict=user_id,lead_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Supabase triage state write failed ${response.status}`);
  return response.json();
}

function findExistingTriageLead(leads, email) {
  const marker = triageLeadMarker(email.id);
  const fromEmail = String(email.from_email || '').trim().toLowerCase();
  const subject = String(email.subject || '').trim().toLowerCase().replace(/^(re|fw|fwd)\s*:\s*/i, '');
  return (leads || []).find((lead) => {
    const text = `${lead.source_rule || ''}\n${lead.notes || ''}\n${lead.raw_preview || ''}`;
    const leadEmail = String(lead.sender_email || '').trim().toLowerCase();
    const leadSubject = String(lead.subject || '').trim().toLowerCase().replace(/^(re|fw|fwd)\s*:\s*/i, '');
    return text.includes(marker) || (fromEmail && subject && leadEmail === fromEmail && leadSubject === subject);
  }) || null;
}

async function upsertTriageLead(email, decision, leads, sequence = 0) {
  const existing = findExistingTriageLead(leads, email);
  const id = existing?.id || (stableTriageLeadId(email.id) + sequence);
  const record = leadRecordFromTriage(email, decision, id);
  const path = existing?.id
    ? `leads?id=eq.${encodeURIComponent(String(existing.id))}`
    : 'leads?on_conflict=id';
  const method = existing?.id ? 'PATCH' : 'POST';
  const response = await supabaseFetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Prefer: existing?.id ? 'return=representation' : 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase triage lead write failed ${response.status}: ${text.slice(0, 200)}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
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

// Process one triage task with a checked decision. Positive decisions write
// LeadFlow/Supabase first, then convert the same Leads & Intake task into the
// follow-up task. Negative/existing/duplicate decisions never create LeadFlow
// records and only complete the original task.
async function processTriageDecision({ task, decision, email, leads, states, sequence }, deps) {
  const emailId = sanitiseText(email.id, 160);
  const baseResult = { task_id: task.id, inbox_id: emailId, decision };

  if (!decisionCreatesFollowUp(decision)) {
    await deps.completeTriageTask(task.id);
    return {
      ...baseResult,
      status: decisionToLeadStatus(decision),
      action: 'completed_without_leadflow',
      completed_triage_task: true,
    };
  }

  let lead;
  try {
    lead = await deps.upsertTriageLead(email, decision, leads, sequence);
  } catch (error) {
    return { ...baseResult, action: 'skipped', reason: 'leadflow_lead_write_failed', error: error?.message || 'unknown' };
  }
  if (!lead || !lead.id) {
    return { ...baseResult, action: 'skipped', reason: 'leadflow_lead_write_returned_no_row' };
  }
  leads.push(lead);

  try {
    await deps.saveTriageState(lead.id, decision, task, states);
  } catch (error) {
    return {
      ...baseResult,
      lead_id: lead.id,
      action: 'skipped',
      reason: 'leadflow_state_write_failed',
      error: error?.message || 'unknown',
    };
  }

  // LeadFlow lead + state confirmed. Only now is it safe to change the To Do
  // task away from triage; keep this original task open as the working item.
  const taskUpdate = await deps.updateTriageTaskToFollowUp(task.id, lead, {
    prospectiveStatus: decisionToLeadStatus(decision),
    decision,
    comment: `Created from To Do triage decision: ${decision}`,
  }, task);

  return {
    ...baseResult,
    lead_id: lead.id,
    status: decisionToLeadStatus(decision),
    action: 'synced',
    follow_up_task_id: taskUpdate?.id || task.id,
    kept_original_task: true,
  };
}

async function pullTriageDecisions({ token, userId, listId }) {
  const [leads, states, tasks] = await Promise.all([loadLeads(), loadStates(), getAllTasks(token, userId, listId)]);
  const results = [];
  let sequence = 0;

  const deps = {
    upsertTriageLead,
    saveTriageState,
    updateTriageTaskToFollowUp: (taskId, lead, state, originalTask) => graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(buildAcceptedTriageTaskPayload({ lead, state, originalTask })),
    }),
    completeTriageTask: (taskId) => graphFetch(token, `/users/${userId}/todo/lists/${listId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    }),
  };

  for (const task of tasks || []) {
    if (String(task.status || '').toLowerCase() === 'completed') continue;
    if (getLeadIdFromTask(task)) continue;
    const emailId = getTriageIdFromTask(task);
    if (!emailId) continue;
    const checklist = await getChecklistItems(token, userId, listId, task.id);
    const checked = getCheckedDecision(checklist);
    if (!checked?.decision) {
      if (checked?.multiple) results.push({ task_id: task.id, inbox_id: emailId, action: 'skipped', reason: 'multiple decisions checked' });
      continue;
    }
    const decision = checked.decision;
    const email = decodeTriagePayload(task) || { id: emailId, subject: task.title, snippet: stripHtml(task.body?.content || '').slice(0, 500) };
    email.id = email.id || emailId;
    const result = await processTriageDecision({ task, decision, email, leads, states, sequence: sequence++ }, deps);
    results.push(result);
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
    const action = body.action || 'sync-lead';

    if (action === 'pull-task-notes') {
      const list = await getTodoList(token, userId, TODO_LIST_NAME);
      const result = await pullTodoUpdates({ token, userId, listId: list.id });
      audit('todo_sync.pull_ok', { ip, user: claims.email || 'pin-session', count: result.results.length });
      return res.status(200).json(result);
    }

    if (action === 'sync-inbox-triage') {
      const emails = Array.isArray(body.candidates) ? body.candidates : (Array.isArray(body.emails) ? body.emails : []);
      const list = await getTodoList(token, userId, TODO_LIST_NAME);
      const result = await syncInboxTriage({ token, userId, listId: list.id, candidates: emails });
      audit('todo_sync.triage_upsert_ok', { ip, user: claims.email || 'pin-session', count: result.results.length });
      return res.status(200).json(result);
    }

    if (action === 'pull-triage-decisions') {
      const list = await getTodoList(token, userId, TODO_LIST_NAME);
      const result = await pullTriageDecisions({ token, userId, listId: list.id });
      audit('todo_sync.triage_pull_ok', { ip, user: claims.email || 'pin-session', count: result.results.length });
      return res.status(200).json(result);
    }

    const list = await getTodoList(token, userId, TODO_LIST_NAME);
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
  TRIAGE_DECISIONS,
  TRACKED_STATUSES,
  buildAcceptedTriageTaskPayload,
  buildTaskBody,
  buildTaskPayload,
  buildTriageTaskBody,
  buildTriageTaskPayload,
  decodeTriagePayload,
  decisionCreatesFollowUp,
  decisionToLeadStatus,
  findTaskForLead,
  findTaskForTriage,
  findConvertedTriageTask,
  getEffectiveStatus,
  getCheckedDecision,
  leadMarker,
  leadRecordFromTriage,
  processTriageDecision,
  shouldSyncLead,
  stripHtml,
  triageMarker,
};
