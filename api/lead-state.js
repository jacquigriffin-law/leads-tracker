'use strict';

const { verifyPinSession } = require('./lib/pin-session');

const STATE_FIELDS = [
  'lead_id', 'user_id', 'actioned', 'leap', 'no_action', 'la_accepted', 'comment',
  'prospective_status', 'follow_up_date', 'conflict_status', 'conflict_notes',
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

  const payload = {
    lead_id: leadId,
    user_id: userId,
    actioned: sanitiseBool(body.actioned),
    leap: sanitiseBool(body.leap),
    no_action: sanitiseBool(body.no_action),
    la_accepted: sanitiseBool(body.la_accepted),
    comment: sanitiseText(body.comment, 10000) || '',
    prospective_status: sanitiseText(body.prospective_status, 80),
    follow_up_date: sanitiseDate(body.follow_up_date),
    conflict_status: sanitiseText(body.conflict_status, 80),
    conflict_notes: sanitiseText(body.conflict_notes, 10000),
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
  return Array.isArray(rows) ? rows[0] : rows;
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

module.exports._test = { sanitiseDate, sanitiseText, sanitiseBool };
