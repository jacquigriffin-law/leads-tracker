#!/usr/bin/env node
// Regression coverage for LeadFlow browser persistence/classification logic.
// Does not touch production APIs. Run: node scripts/test-app-persistence.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function makeElement(id = '') {
  return {
    id,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    scrollIntoView() {},
    focus() {},
  };
}

function loadAppSandbox() {
  const storage = new Map();
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    body: { style: {} },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const sandbox = {
    console,
    document,
    localStorage,
    navigator: { serviceWorker: undefined, standalone: false },
    location: { href: 'https://leadflow.test/' },
    URL,
    URLSearchParams,
    AbortController,
    FormData,
    CSS: { escape: (value) => String(value) },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = {
    navigator: sandbox.navigator,
    location: sandbox.location,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    history: { replaceState() {} },
    scrollTo() {},
  };
  sandbox.globalThis = sandbox;

  const appPath = path.join(__dirname, '..', 'app.js');
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/\nstart\(\)\.catch\(handleError\);\s*$/, '');
  source += `
globalThis.__leadflowAppTest = {
  app,
  getLeadState,
  setLeadState,
  getEffectiveProspectiveStatus,
  getPipelineTab,
  getDurableStateForHidden,
  inboxEmailNeedsAction,
  importInboxEmailWithStage,
  loadSupabaseState,
  saveStateRemote,
};
`;
  vm.runInNewContext(source, sandbox, { filename: appPath });
  return { sandbox, api: sandbox.__leadflowAppTest, storage };
}

(async () => {
  const { sandbox, api, storage } = loadAppSandbox();
  const { app } = api;

  console.log('\npipeline status from production base schema');
  {
    assert('existing_matter lead.status renders Closed', api.getPipelineTab({ status: 'existing_matter' }, api.getLeadState('1')) === 'closed');
    assert('declined lead.status renders Closed', api.getPipelineTab({ status: 'declined' }, api.getLeadState('2')) === 'closed');
    assert('closed lead.status renders Closed', api.getPipelineTab({ status: 'closed' }, api.getLeadState('3')) === 'closed');
    assert('follow_up lead.status renders Follow-up', api.getPipelineTab({ status: 'follow_up' }, api.getLeadState('4')) === 'followup');
    assert('base actioned state overrides status=new after refresh', api.getPipelineTab({ status: 'new' }, { actioned: true }) === 'closed');
    assert('base no_action state overrides status=new after refresh', api.getPipelineTab({ status: 'new' }, { noAction: true }) === 'closed');
    assert('base leap state overrides status=new after refresh', api.getPipelineTab({ status: 'new' }, { actioned: true, leap: true }) === 'closed');
  }

  console.log('\nbase lead_states rows do not wipe local extended state');
  {
    app.supabase = { rpc: async () => ({ error: null }) };
    app.session = { access_token: 'pin-session', user: { email: 'pin-session' } };
    app.remoteLeadIds = new Set([42]);
    api.setLeadState('42', {
      prospectiveStatus: 'declined',
      followUpDate: '2026-06-30',
      conflictStatus: 'requested',
      conflictNotes: 'local note',
    });
    sandbox.fetch = async (url, options = {}) => {
      assert('loads lead-state through API', String(url).startsWith('/api/lead-state'), String(url));
      assert('uses no-store for lead-state refresh', options.cache === 'no-store', JSON.stringify(options));
      return {
        ok: true,
        json: async () => ({
          states: [{ lead_id: 42, actioned: true, leap: false, no_action: true, la_accepted: false, comment: 'server comment' }],
        }),
      };
    };
    await api.loadSupabaseState();
    const state = api.getLeadState('42');
    assert('keeps local prospectiveStatus when production row has no extended column', state.prospectiveStatus === 'declined', JSON.stringify(state));
    assert('keeps local conflictStatus when production row has no extended column', state.conflictStatus === 'requested', JSON.stringify(state));
    assert('applies base actioned/noAction fields', state.actioned === true && state.noAction === true, JSON.stringify(state));
  }

  console.log('\nlocal hidden/delete state is archived durably');
  {
    const hiddenState = api.getDurableStateForHidden({ hidden: true, actioned: false, noAction: false, prospectiveStatus: '' });
    assert('hidden maps to closed no-response', hiddenState.hidden === false && hiddenState.actioned === true && hiddenState.noAction === true && hiddenState.prospectiveStatus === 'closed_no_response', JSON.stringify(hiddenState));

    app.supabase = { rpc: async () => ({ error: null }) };
    app.session = { access_token: 'pin-session', user: { email: 'pin-session' } };
    app.remoteLeadIds = new Set([1234]);
    api.setLeadState('1234', { hidden: true });
    sandbox.fetch = async (url, options = {}) => {
      assert('saves hidden lead through lead-state API', String(url) === '/api/lead-state', String(url));
      const body = JSON.parse(options.body);
      assert('hidden save uses durable closed payload', body.actioned === true && body.no_action === true && body.prospective_status === 'closed_no_response', JSON.stringify(body));
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await api.saveStateRemote('1234');
  }

  console.log('\nsaved/closed inbox messages stay suppressed');
  {
    app.leads = [{
      id: 99,
      sender_name: 'Client Example',
      sender_email: 'client@example.com',
      subject: 'Your Family Law Matter',
      status: 'existing_matter',
    }];
    app.inboxImported = new Set();
    const email = { id: 'email-99', from_email: 'client@example.com', subject: 'RE: Your Family Law Matter' };
    assert('matches saved lead despite reply prefix', api.inboxEmailNeedsAction(email) === false);
  }

  console.log('\nimport existing matter persists before render');
  {
    const calls = [];
    app.config.supabase.enabled = true;
    app.supabase = { rpc: async () => ({ error: null }) };
    app.session = { access_token: 'pin-session', user: { email: 'pin-session' } };
    app.inbox = [{
      id: 'inbox-existing-1',
      from_name: 'Existing Client',
      from_email: 'existing@example.com',
      subject: 'Existing matter update',
      received_at: '2026-06-15T00:00:00.000Z',
      snippet: 'Please add this to the matter.',
      source_account: 'JGMS',
    }];
    app.inboxImported = new Set();
    app.inboxDismissed = new Set();
    app.leads = [];
    app.remoteLeadIds = new Set();
    sandbox.fetch = async (url, options = {}) => {
      if (String(url) === '/api/leads' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        calls.push(['lead-post', body.status]);
        assert('existing import posts production-allowed status', body.status === 'existing_matter', JSON.stringify(body));
        return { ok: true, json: async () => ({ lead: { id: 777, ...body } }) };
      }
      if (String(url).startsWith('/api/leads')) {
        calls.push(['lead-get']);
        return { ok: true, json: async () => ({ leads: [{ id: 777, sender_name: 'Existing Client', sender_email: 'existing@example.com', subject: 'Existing matter update', status: 'existing_matter' }] }) };
      }
      if (String(url) === '/api/lead-state') {
        const body = JSON.parse(options.body);
        calls.push(['state-post', body.prospective_status]);
        assert('existing import posts base state before rendering', body.lead_id === 777 && body.actioned === true && body.no_action === true, JSON.stringify(body));
        return { ok: true, json: async () => ({ ok: true, state: { lead_id: 777, actioned: true, no_action: true } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    await api.importInboxEmailWithStage('inbox-existing-1', 'existing_matter');
    assert('state save completed during import flow', calls.some((call) => call[0] === 'state-post'), JSON.stringify(calls));
    assert('existing import moves UI to Closed', app.currentTab === 'closed', app.currentTab);
    assert('imported email remains suppressed after save', api.inboxEmailNeedsAction(app.inbox[0]) === false);
    assert('imported id is persisted locally as a secondary guard', JSON.parse(storage.get('xena-leads-inbox-imported') || '[]').includes('inbox-existing-1'));
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
