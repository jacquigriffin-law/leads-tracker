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
  assert('urgent lead stays normal importance by default', payload.importance === 'normal', JSON.stringify(payload));
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
  assert('Leads & Intake is the single To Do queue', todoSync.TODO_LIST_NAME === 'Leads & Intake', todoSync.TODO_LIST_NAME);
  assert('old triage list constant is not exported', !('TRIAGE_LIST_NAME' in todoSync), Object.keys(todoSync).join(','));
  assert('old follow-up list constant is not exported', !('FOLLOW_UP_LIST_NAME' in todoSync), Object.keys(todoSync).join(','));
  assert('decision checklist order matches single-queue workflow', todoSync.TRIAGE_DECISIONS.join('|') === 'CALL FIRST|YES - prospective lead|NO - not a lead|EXISTING MATTER|DUPLICATE', todoSync.TRIAGE_DECISIONS.join('|'));
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
  assert('triage task stays normal importance by default', payload.importance === 'normal', JSON.stringify(payload));
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
  assert('reads exactly one checked decision', decision?.decision === 'YES - prospective lead' && decision.multiple === false, JSON.stringify(decision));
  const duplicateDecision = todoSync.getCheckedDecision([
    { displayName: 'YES - prospective lead', isChecked: true },
    { displayName: 'NO - not a lead', isChecked: true },
  ]);
  assert('ignores ambiguous checked decisions', duplicateDecision?.decision === null && duplicateDecision.multiple === true, JSON.stringify(duplicateDecision));
  const leadRecord = todoSync.leadRecordFromTriage(email, 'CALL FIRST', 456);
  assert('triage lead record stores To Do source', leadRecord.id === 456 && leadRecord.source_platform === 'To Do triage', JSON.stringify(leadRecord));
  assert('triage lead record stores next action', leadRecord.status === 'follow_up' && leadRecord.next_action.includes('Call first'), JSON.stringify(leadRecord));
  const acceptedPayload = todoSync.buildAcceptedTriageTaskPayload({
    lead: leadRecord,
    state: { prospectiveStatus: 'follow_up', decision: 'CALL FIRST', comment: 'Created from decision.' },
    originalTask: { id: 'triage-task-1', title: payload.title, body: payload.body },
  });
  assert('accepted triage task is renamed as LeadFlow follow-up', acceptedPayload.title.startsWith('LeadFlow: Sarah Sample'), acceptedPayload.title);
  assert('accepted triage task keeps original To Do item open', acceptedPayload.status === 'notStarted', JSON.stringify(acceptedPayload));
  assert('accepted triage task carries LeadFlow marker', acceptedPayload.body.content.includes('[leadflow:456]'), acceptedPayload.body.content);
  assert('accepted triage task records source without triage marker reprocessing', acceptedPayload.body.content.includes('LeadFlow source inbox id: jgms-abc123') && !acceptedPayload.body.content.includes('[leadflow-triage:'), acceptedPayload.body.content);
  assert('accepted triage task remains normal importance', acceptedPayload.importance === 'normal', JSON.stringify(acceptedPayload));
  assert('converted task is found for duplicate prevention', todoSync.findConvertedTriageTask([{ id: 'converted', body: acceptedPayload.body }], 'jgms-abc123').id === 'converted');
  assert('converted task is not treated as active triage', todoSync.findTaskForTriage([{ id: 'converted', title: acceptedPayload.title, body: acceptedPayload.body }], 'jgms-abc123') === null);
}

async function runAsyncTests() {
  console.log('\nTriage decision LeadFlow-first guard');
  const task = { id: 'todo-task-1', title: 'TRIAGE - JGMS - Parenting - Sarah', body: { contentType: 'text', content: '' } };
  const email = { id: 'email-1', from_name: 'Sarah Sample', subject: 'Parenting matter' };

  const successfulCalls = [];
  const success = await todoSync.processTriageDecision({
    task,
    decision: 'CALL FIRST',
    email,
    leads: [],
    states: [{ user_id: 'pin-user-1' }],
    sequence: 0,
  }, {
    upsertTriageLead: async () => {
      successfulCalls.push('lead');
      return { id: 456, sender_name: 'Sarah Sample', status: 'follow_up' };
    },
    saveTriageState: async () => {
      successfulCalls.push('state');
      return [{ lead_id: 456 }];
    },
    getIntakeList: async () => {
      successfulCalls.push('list');
      throw new Error('old duplicate list path should not be used');
    },
    upsertLeadTask: async () => {
      throw new Error('old duplicate task path should not be used');
    },
    updateTriageTaskToFollowUp: async (taskId) => {
      successfulCalls.push(`update:${taskId}`);
      return { id: taskId };
    },
    completeTriageTask: async () => {
      successfulCalls.push('complete');
    },
  });
  assert('successful triage sync updates same task only after LeadFlow writes', successfulCalls.join('>') === 'lead>state>update:todo-task-1', successfulCalls.join('>'));
  assert('successful triage sync reports same task as follow-up', success.action === 'synced' && success.follow_up_task_id === 'todo-task-1' && success.kept_original_task === true, JSON.stringify(success));

  const failedCalls = [];
  const failed = await todoSync.processTriageDecision({
    task,
    decision: 'CALL FIRST',
    email,
    leads: [],
    states: [{ user_id: 'pin-user-1' }],
    sequence: 0,
  }, {
    upsertTriageLead: async () => {
      failedCalls.push('lead');
      return { id: 789, sender_name: 'Sarah Sample', status: 'follow_up' };
    },
    saveTriageState: async () => {
      failedCalls.push('state');
      throw new Error('state write failed');
    },
    getIntakeList: async () => {
      failedCalls.push('list');
      return { id: 'follow-ups' };
    },
    upsertLeadTask: async () => {
      failedCalls.push('todo');
      return { task: { id: 'should-not-exist' } };
    },
    updateTriageTaskToFollowUp: async () => {
      failedCalls.push('update');
      return { id: 'should-not-update' };
    },
    completeTriageTask: async () => {
      failedCalls.push('complete');
    },
  });
  assert('failed LeadFlow state write does not change or complete To Do triage task', failedCalls.join('>') === 'lead>state', failedCalls.join('>'));
  assert('failed LeadFlow state write reports skipped', failed.action === 'skipped' && failed.reason === 'leadflow_state_write_failed', JSON.stringify(failed));

  const negativeCalls = [];
  const negative = await todoSync.processTriageDecision({
    task,
    decision: 'NO - not a lead',
    email,
    leads: [],
    states: [{ user_id: 'pin-user-1' }],
    sequence: 0,
  }, {
    upsertTriageLead: async () => {
      negativeCalls.push('lead');
      return { id: 999 };
    },
    saveTriageState: async () => {
      negativeCalls.push('state');
      return [{ lead_id: 999 }];
    },
    updateTriageTaskToFollowUp: async () => {
      negativeCalls.push('update');
      return { id: 'should-not-update' };
    },
    completeTriageTask: async () => {
      negativeCalls.push('complete');
    },
  });
  assert('negative triage decision does not write LeadFlow', negativeCalls.join('>') === 'complete', negativeCalls.join('>'));
  assert('negative triage decision completes without lead id', negative.action === 'completed_without_leadflow' && negative.completed_triage_task === true && !negative.lead_id, JSON.stringify(negative));
}

runAsyncTests()
  .then(() => {
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
