#!/usr/bin/env node
// Regression tests for LeadFlow auth cookie restoration. No network calls.

'use strict';

const path = require('path');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  const savedEnv = {
    LEADFLOW_SESSION_SECRET: process.env.LEADFLOW_SESSION_SECRET,
    LEADFLOW_SESSION_EMAIL: process.env.LEADFLOW_SESSION_EMAIL,
  };
  process.env.LEADFLOW_SESSION_SECRET = 'test-secret-for-cookie-restore';
  process.env.LEADFLOW_SESSION_EMAIL = 'jacquigriffin@mobilesolicitor.com.au';

  const auth = require(path.join(__dirname, '..', 'api', 'auth'));
  const { createSessionToken, SESSION_TTL_MS } = require(path.join(__dirname, '..', 'api', 'lib', 'pin-session'));
  const token = createSessionToken();
  const sixMonthsMs = 180 * 24 * 60 * 60 * 1000;

  console.log('\nGET /api/auth');
  {
    const req = { method: 'GET', headers: { cookie: `leadflow_session=${encodeURIComponent(token)}` } };
    const res = makeRes();
    await auth(req, res);
    assert('valid cookie returns 200', res.statusCode === 200, `status=${res.statusCode}`);
    assert('valid cookie authenticates', res.body.authenticated === true, JSON.stringify(res.body));
    assert('returns existing token for localStorage rebuild', res.body.token === token);
    assert('returns expiry for localStorage rebuild', typeof res.body.expires_at === 'string' && res.body.expires_at.includes('T'), JSON.stringify(res.body));
    assert('LeadFlow session lasts roughly six months', SESSION_TTL_MS === sixMonthsMs, `ttl=${SESSION_TTL_MS}`);
    assert('does not return PIN', !('pin' in res.body), JSON.stringify(res.body));
  }

  {
    const req = { method: 'GET', headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    await auth(req, res);
    assert('GET does not rebuild from Authorization header', res.body.authenticated === false, JSON.stringify(res.body));
    assert('GET without cookie returns no token', res.body.token === null, JSON.stringify(res.body));
  }

  console.log('\nPOST /api/auth');
  {
    const req = { method: 'POST', headers: {} };
    const res = makeRes();
    await auth(req, res);
    assert('POST creates app session without PIN body', res.statusCode === 200, `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
    assert('POST returns authenticated session token', res.body.authenticated === true && typeof res.body.token === 'string' && res.body.token.length > 20, JSON.stringify(res.body));
    assert('POST sets HttpOnly session cookie', String(res.headers['Set-Cookie'] || '').includes('HttpOnly'), String(res.headers['Set-Cookie'] || ''));
  }

  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
