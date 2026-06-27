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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
