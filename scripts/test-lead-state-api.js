#!/usr/bin/env node
// Regression tests for /api/lead-state.js.
// Does NOT make network calls or require Supabase credentials.
// Run: node scripts/test-lead-state-api.js

'use strict';

const path = require('path');
const {
  STATE_FIELDS,
  deriveCoreState,
  leadStatusFromProspective,
  loadStates,
  saveState,
} = require(path.join(__dirname, '..', 'api', 'lead-state'))._test;

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function withMockedSupabase(fetchImpl, fn) {
  const savedFetch = global.fetch;
  const savedEnv = {
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    LEADFLOW_PIN_USER_ID: process.env.LEADFLOW_PIN_USER_ID,
  };
  global.fetch = fetchImpl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  try {
    await fn();
  } finally {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

(async () => {
  console.log('\nSTATE_FIELDS');
  {
    const optionalFields = ['prospective_status', 'follow_up_date', 'conflict_status', 'conflict_notes'];
    for (const field of optionalFields) {
      assert(`${field} is not selected unconditionally`, !STATE_FIELDS.includes(field));
    }
    assert('core lead_id is selected', STATE_FIELDS.includes('lead_id'));
    assert('core comment is selected', STATE_FIELDS.includes('comment'));
  }

  console.log('\nloadStates');
  await withMockedSupabase(async (url) => {
    const u = String(url);
    assert('read select uses only core state fields', u.includes(`select=${STATE_FIELDS.join(',')}`), u);
    return jsonResponse(200, [{ lead_id: 123, actioned: true, comment: 'ok' }]);
  }, async () => {
    const rows = await loadStates();
    assert('loads state rows', rows.length === 1 && rows[0].lead_id === 123);
  });

  console.log('\nsaveState');
  {
    let postedBody = null;
    let patchedLeadStatus = null;
    await withMockedSupabase(async (url, options = {}) => {
      const u = String(url);
      if (u.includes('select=user_id')) {
        return jsonResponse(200, [{ user_id: '00000000-0000-0000-0000-000000000001' }]);
      }
      if (options.method === 'PATCH' && u.includes('/rest/v1/leads?')) {
        patchedLeadStatus = JSON.parse(options.body).status;
        return jsonResponse(204, null);
      }
      if (options.method === 'POST') {
        postedBody = JSON.parse(options.body);
        return jsonResponse(200, [postedBody]);
      }
      return jsonResponse(500, { message: 'unexpected mock path' });
    }, async () => {
      const row = await saveState({
        lead_id: 123,
        actioned: true,
        prospective_status: 'existing_matter',
        follow_up_date: '2026-06-30',
        conflict_status: 'requested',
        conflict_notes: 'check started',
      });
      assert('writes core state', row.lead_id === 123 && row.actioned === true);
      assert('omits optional migration fields from write payload', !('prospective_status' in postedBody) && !('conflict_status' in postedBody));
      assert('keeps comment field in write payload', 'comment' in postedBody);
      assert('mirrors follow-up stage onto lead.status', patchedLeadStatus === 'closed');
    });
  }

  console.log('\nderiveCoreState / leadStatusFromProspective');
  {
    const closed = deriveCoreState({ prospective_status: 'closed_no_response' });
    assert('closed_no_response derives actioned', closed.actioned === true);
    assert('closed_no_response derives no_action', closed.no_action === true);
    const opened = deriveCoreState({ prospective_status: 'opened_in_leap' });
    assert('opened_in_leap derives leap', opened.actioned === true && opened.leap === true);
    assert('awaiting_reply maps to follow_up', leadStatusFromProspective('awaiting_reply') === 'follow_up');
    assert('ready_for_leap maps to follow_up on base schema', leadStatusFromProspective('ready_for_leap') === 'follow_up');
    assert('declined maps to closed', leadStatusFromProspective('declined') === 'closed');
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
