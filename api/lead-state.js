'use strict';

const { verifyPinSession } = require('./lib/pin-session');

// Keep this to base-schema columns. Optional state migrations may not be present
// in production, so selecting or writing them unconditionally can 500 the API.
const STATE_FIELDS = [
  'lead_id', 'user_id', 'actioned', 'leap', 'no_action', 'la_accepted', 'comment',
];

function audit(event, details) {
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...details }));
}

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
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

async function resolveStateUserId(leadId) {
  if (process.env.LEADFLOW_PIN_USER_ID) return process.env.LEADFLOW_PIN_USER_ID;

  const leadFilter = leadId ? `&lead_id=eq.${encodeURIComponent(String(leadId))}` : '';
  let response = await supabaseFetch(`lead_states?select=user_id${leadFilter}&limit=1`);
  if (response.ok) {
    const rows = await response.json().catch(() => []);
    if (rows?.[0]?.user_id) return rows[0].user_id;
  }

  response = await supabaseFetch('lead_states?select=user_id&limit=1');
  if (response.ok) {
    const rows = await response.json().catch(() => []);
    if (rows?.[0]?.user_id) return rows[0].user_id;
  }

  return null;
}

function sanitiseBool(value) {
  return Boolean(value);
}

function sanitiseText(value, max = 4000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function sanitiseDate(value) {
  const text = sanitiseText(value, 32);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function deriveCoreState(body) {
  const prospectiveStatus = sanitiseText(body.prospective_status, 64);
  const terminalStatuses = new Set([
    'opened_in_leap',
    'existing_matter',
    'not_a_lead',
    'declined',
    'closed_no_response',
  ]);
  const next = {
    actioned: sanitiseBool(body.actioned),
    leap: sanitiseBool(body.leap),
    no_action: sanitiseBool(body.no_action),
    la_accepted: sanitiseBool(body.la_accepted),
  };

  if (prospectiveStatus === 'opened_in_leap') {
    next.actioned = true;
    next.leap = true;
  }
  if (['existing_matter', 'not_a_lead', 'declined', 'closed_no_response'].includes(prospectiveStatus)) {
    next.actioned = true;
    next.no_action = true;
  }

  return { ...next, prospectiveStatus, terminal: terminalStatuses.has(prospectiveStatus) };
}

function leadStatusFromProspective(value) {
  if (!value) return null;
  if (['opened_in_leap', 'existing_matter', 'not_a_lead', 'declined', 'closed_no_response'].includes(value)) {
    return 'closed';
  }
  if (['contacted', 'awaiting_reply', 'awaiting_documents', 'awaiting_legal_aid', 'ready_for_leap'].includes(value)) {
    return 'follow_up';
  }
  if (value === 'new_lead') return 'new';
  return null;
}

async function loadStates() {
  const response = await supabaseFetch(`lead_states?select=${STATE_FIELDS.join(',')}`);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase state read failed ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function saveState(body) {
  const leadId = Number(body.lead_id);
  if (!Number.isFinite(leadId)) {
    const error = new Error('lead_id is required');
    error.statusCode = 400;
    throw error;
  }

  const userId = await resolveStateUserId(leadId);
  if (!userId) {
    const error = new Error('Lead state user is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const derived = deriveCoreState(body);
  const payload = {
    lead_id: leadId,
    user_id: userId,
    actioned: derived.actioned,
    leap: derived.leap,
    no_action: derived.no_action,
    la_accepted: derived.la_accepted,
    comment: sanitiseText(body.comment, 10000) || '',
  };

  const response = await supabaseFetch('lead_states?on_conflict=user_id,lead_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase state write failed ${response.status}: ${text.slice(0, 200)}`);
  }

  const rows = await response.json();
  const saved = Array.isArray(rows) ? rows[0] : rows;

  const leadStatus = leadStatusFromProspective(derived.prospectiveStatus);
  if (leadStatus) {
    const statusResponse = await supabaseFetch(`leads?id=eq.${encodeURIComponent(String(leadId))}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: leadStatus }),
    });
    if (!statusResponse.ok) {
      const text = await statusResponse.text().catch(() => '');
      throw new Error(`Supabase lead status write failed ${statusResponse.status}: ${text.slice(0, 200)}`);
    }
  }

  return saved;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');

  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const ip = clientIp(req);
  const claims = verifyPinSession(req);
  if (!claims) {
    audit('lead_state.auth_failed', { ip });
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    if (req.method === 'GET') {
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        audit('lead_state.read_fallback_empty', { ip, user: claims.email || 'pin-session' });
        return res.status(200).json({ ok: true, states: [] });
      }
      const states = await loadStates();
      audit('lead_state.read_ok', { ip, user: claims.email || 'pin-session', count: Array.isArray(states) ? states.length : 0 });
      return res.status(200).json({ ok: true, states: Array.isArray(states) ? states : [] });
    }

    const body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      audit('lead_state.write_fallback_local_only', {
        ip,
        user: claims.email || 'pin-session',
        lead_id: body?.lead_id || null,
      });
      return res.status(200).json({ ok: true, state: null, source: 'local-only' });
    }
    const state = await saveState(body);
    audit('lead_state.write_ok', { ip, user: claims.email || 'pin-session', lead_id: state?.lead_id });
    return res.status(200).json({ ok: true, state });
  } catch (err) {
    const status = err.statusCode || 500;
    audit('lead_state.error', { ip, user: claims.email || 'pin-session', error: err?.message || 'unknown' });
    return res.status(status).json({ error: status === 503 ? err.message : 'Failed to sync lead state.' });
  }
};

module.exports._test = {
  STATE_FIELDS,
  sanitiseDate,
  sanitiseText,
  sanitiseBool,
  deriveCoreState,
  leadStatusFromProspective,
  loadStates,
  saveState,
};
