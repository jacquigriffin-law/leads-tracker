#!/usr/bin/env node
// Static unit tests for /api/leads.js — field validation and env-gate logic.
// Does NOT make network calls or require Supabase credentials.
// Run: node scripts/test-leads-api.js
// Exits 0 on pass, 1 on any failure.

'use strict';

const path = require('path');
const { validateAndSanitise, ALLOWED_FIELDS, VALID_PRIORITIES, VALID_STATUSES } =
  require(path.join(__dirname, '..', 'api', 'leads'))._test;

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

// ── validateAndSanitise — required fields ─────────────────────────────────────
console.log('\nvalidateAndSanitise — required fields');
{
  const { errors } = validateAndSanitise({});
  assert('rejects missing sender_name', Array.isArray(errors) && errors.length > 0);
  assert('error mentions sender_name', errors && errors.join('').includes('sender_name'));
}
{
  const { errors } = validateAndSanitise({ sender_name: '   ' });
  assert('rejects blank sender_name', Array.isArray(errors));
}
{
  const { record, errors } = validateAndSanitise({ sender_name: 'Jane Smith' });
  assert('accepts valid sender_name', !errors && record.sender_name === 'Jane Smith');
}

// ── validateAndSanitise — string trimming and length cap ──────────────────────
console.log('\nvalidateAndSanitise — sanitisation');
{
  const { record } = validateAndSanitise({ sender_name: '  Padded  ', sender_email: '  a@b.com  ' });
  assert('trims sender_name whitespace', record.sender_name === 'Padded');
  assert('trims sender_email whitespace', record.sender_email === 'a@b.com');
}
{
  const longStr = 'x'.repeat(300);
  const { record } = validateAndSanitise({ sender_name: 'A', sender_phone: longStr });
  assert('caps sender_phone at 1000 chars', record.sender_phone.length <= 1000);
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', notes: 'x'.repeat(20_000) });
  assert('caps notes at 10 000 chars', record.notes.length <= 10_000);
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', raw_preview: 'x'.repeat(20_000) });
  assert('caps raw_preview at 10 000 chars', record.raw_preview.length <= 10_000);
}

// ── validateAndSanitise — empty strings become null (omitted from record) ─────
console.log('\nvalidateAndSanitise — empty strings omitted');
{
  const { record } = validateAndSanitise({ sender_name: 'A', sender_phone: '', notes: '' });
  assert('empty sender_phone omitted from record', !('sender_phone' in record));
  assert('empty notes omitted from record', !('notes' in record));
}

// ── validateAndSanitise — priority allowlist ──────────────────────────────────
console.log('\nvalidateAndSanitise — priority');
for (const p of ['URGENT', 'HIGH', 'MEDIUM', 'LOW']) {
  const { record } = validateAndSanitise({ sender_name: 'A', priority: p });
  assert(`accepts priority ${p}`, record.priority === p);
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', priority: 'urgent' });
  assert('lower-cases priority coerced to uppercase', record.priority === 'URGENT');
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', priority: 'INVALID' });
  assert('unknown priority defaults to MEDIUM', record.priority === 'MEDIUM');
}

// ── validateAndSanitise — status allowlist ────────────────────────────────────
console.log('\nvalidateAndSanitise — status');
for (const s of ['new', 'follow_up', 'existing_matter', 'closed']) {
  const { record } = validateAndSanitise({ sender_name: 'A', status: s });
  assert(`accepts status ${s}`, record.status === s);
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', status: 'GIBBERISH' });
  assert('unknown status defaults to new', record.status === 'new');
}

// ── validateAndSanitise — date_received ──────────────────────────────────────
console.log('\nvalidateAndSanitise — date_received');
{
  const iso = '2026-04-30T10:00:00.000Z';
  const { record } = validateAndSanitise({ sender_name: 'A', date_received: iso });
  assert('valid ISO date preserved', record.date_received === iso);
}
{
  const { record } = validateAndSanitise({ sender_name: 'A', date_received: 'not-a-date' });
  assert('invalid date replaced with now', !isNaN(new Date(record.date_received).getTime()));
}
{
  const before = Date.now();
  const { record } = validateAndSanitise({ sender_name: 'A' });
  const after = Date.now();
  const ts = new Date(record.date_received).getTime();
  assert('missing date_received defaults to now', ts >= before && ts <= after);
}

// ── validateAndSanitise — unknown keys stripped (field allowlist) ─────────────
console.log('\nvalidateAndSanitise — unknown keys stripped');
{
  const { record } = validateAndSanitise({
    sender_name: 'A',
    id: 99999,
    created_at: '2020-01-01',
    reviewed_at: '2025-01-01',
    __proto__: { evil: true },
    arbitrary_field: 'should not appear',
  });
  assert('id not in record', !('id' in record));
  assert('created_at not in record', !('created_at' in record));
  assert('reviewed_at not in record', !('reviewed_at' in record));
  assert('arbitrary_field not in record', !('arbitrary_field' in record));
}

// ── ALLOWED_FIELDS sanity check ───────────────────────────────────────────────
console.log('\nALLOWED_FIELDS sanity');
{
  const forbidden = ['id', 'created_at', 'updated_at', 'reviewed_at'];
  for (const f of forbidden) {
    assert(`${f} not in ALLOWED_FIELDS`, !ALLOWED_FIELDS.has(f));
  }
  assert('sender_name in ALLOWED_FIELDS', ALLOWED_FIELDS.has('sender_name'));
  assert('notes in ALLOWED_FIELDS', ALLOWED_FIELDS.has('notes'));
}

// ── VALID_PRIORITIES / VALID_STATUSES ─────────────────────────────────────────
console.log('\nAllowlists completeness');
{
  assert('URGENT in VALID_PRIORITIES', VALID_PRIORITIES.has('URGENT'));
  assert('LOW in VALID_PRIORITIES', VALID_PRIORITIES.has('LOW'));
  assert('new in VALID_STATUSES', VALID_STATUSES.has('new'));
  assert('follow_up in VALID_STATUSES', VALID_STATUSES.has('follow_up'));
  assert('existing_matter in VALID_STATUSES', VALID_STATUSES.has('existing_matter'));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
