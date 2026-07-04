#!/usr/bin/env node
// Unit tests for LeadFlow <-> Microsoft To Do sync helpers. No network calls.

'use strict';

const path = require('path');
const todoSync = require(path.join(__dirname, '..', 'api', 'todo-sync'))._test;

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

console.log('\nTo Do task payload');
{
  const lead = {
    id: 123,
    sender_name: 'Jane Example',
    sender_phone: '0400 000 000',
    sender_email: 'jane@example.com',
    subject: 'Parenting matter',
    matter_type: 'Family Law',
    priority: 'URGENT',
    location: 'NSW',
    next_action: 'Call today',
  };
  const state = {
    prospectiveStatus: 'awaiting_reply',
    followUpDate: '2026-06-30',
    comment: 'Left voicemail.',
  };
  const payload = todoSync.buildTaskPayload(lead, state);
  assert('task title names LeadFlow and client', payload.title.includes('LeadFlow: Jane Example'), payload.title);
  assert('task body includes lead marker', payload.body.content.includes('[leadflow:123]'), payload.body.content);
  assert('task body includes status', payload.body.content.includes('Awaiting Reply'), payload.body.content);
  assert('urgent lead maps to high importance', payload.importance === 'high', JSON.stringify(payload));
  assert('follow-up date maps to dueDateTime', payload.dueDateTime.dateTime.startsWith('2026-06-30'), JSON.stringify(payload));
}

console.log('\nTask matching and status filter');
{
  const tasks = [
    { id: 'other', title: 'Unrelated', body: { contentType: 'text', content: 'No marker' } },
    { id: 'match', title: 'LeadFlow task', body: { contentType: 'html', content: '<p>[leadflow:789]</p>' } },
  ];
  assert('finds task by marker in HTML body', todoSync.findTaskForLead(tasks, 789).id === 'match');
  assert('contacted should sync', todoSync.shouldSyncLead({ status: 'new' }, { prospectiveStatus: 'contacted' }) === true);
  assert('closed no response should not sync', todoSync.shouldSyncLead({ status: 'new' }, { prospectiveStatus: 'closed_no_response' }) === false);
}

console.log('\nInbox triage task payload and decisions');
{
  const email = {
    id: 'jgms-abc123',
    from_name: 'Sarah Sample',
    from_email: 'sarah@example.com',
    phone: '0400 111 222',
    subject: 'Need help with parenting matter',
    received_at: '2026-07-04T09:00:00.000Z',
    snippet: 'I need legal help with a parenting dispute.',
    source_label: 'JGMS',
    source_account: 'JGMS',
  };
  const payload = todoSync.buildTriageTaskPayload(email);
  assert('triage task title starts with TRIAGE', payload.title.startsWith('TRIAGE - JGMS'), payload.title);
  assert('triage body includes marker', payload.body.content.includes('[leadflow-triage:jgms-abc123]'), payload.body.content);
  assert('triage body includes payload marker', payload.body.content.includes('XENA_TRIAGE_PAYLOAD:'), payload.body.content);
  const decoded = todoSync.decodeTriagePayload({ body: payload.body });
  assert('triage payload decodes safely', decoded.id === 'jgms-abc123' && decoded.snippet.includes('parenting'), JSON.stringify(decoded));
  assert('finds triage task by marker', todoSync.findTaskForTriage([{ id: 't1', title: payload.title, body: payload.body }], 'jgms-abc123').id === 't1');
  assert('YES maps to new lead', todoSync.decisionToLeadStatus('YES - prospective lead') === 'new');
  assert('CALL FIRST maps to follow_up', todoSync.decisionToLeadStatus('CALL FIRST') === 'follow_up');
  assert('NO maps to not_a_lead', todoSync.decisionToLeadStatus('NO - not a lead') === 'not_a_lead');
  assert('CALL FIRST creates follow-up', todoSync.decisionCreatesFollowUp('CALL FIRST') === true);
  assert('NO does not create follow-up', todoSync.decisionCreatesFollowUp('NO - not a lead') === false);
  const decision = todoSync.getCheckedDecision([
    { displayName: 'YES - prospective lead', isChecked: true },
    { displayName: 'NO - not a lead', isChecked: false },
  ]);
  assert('reads exactly one checked decision', decision === 'YES - prospective lead', decision);
  const duplicateDecision = todoSync.getCheckedDecision([
    { displayName: 'YES - prospective lead', isChecked: true },
    { displayName: 'NO - not a lead', isChecked: true },
  ]);
  assert('ignores ambiguous checked decisions', duplicateDecision === null, duplicateDecision);
  const leadRecord = todoSync.leadRecordFromTriage(email, 'CALL FIRST', 456);
  assert('triage lead record stores To Do source', leadRecord.id === 456 && leadRecord.source_platform === 'To Do triage', JSON.stringify(leadRecord));
  assert('triage lead record stores next action', leadRecord.status === 'follow_up' && leadRecord.next_action.includes('Call first'), JSON.stringify(leadRecord));
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
