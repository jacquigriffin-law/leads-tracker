#!/usr/bin/env node
// Verification script for api/inbox.js coverage widening.
// Run: node scripts/test-inbox.js

'use strict';

const path = require('path');
const Module = require('module');

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

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'imapflow') {
    return {
      ImapFlow: class FakeImapFlow {
        constructor() {
          this.mailbox = { exists: 0 };
        }
      },
    };
  }
  if (request === 'mailparser') {
    return {
      simpleParser: async () => ({ from: { value: [{ name: '', address: '' }] }, text: '', subject: '', date: new Date('2026-04-29T00:00:00.000Z') }),
    };
  }
  return realLoad(request, parent, isMain);
};

async function main() {
  const inbox = require(path.join(__dirname, '..', 'api', 'inbox.js'));
  Module._load = realLoad;

  const { fetchJGMS, fetchIMAP, getInboxFetchConfig } = inbox._test;

  console.log('\ngetInboxFetchConfig');

  {
    delete process.env.INBOX_LOOKBACK_DAYS;
    delete process.env.INBOX_MAX_PER_SOURCE;
    const config = getInboxFetchConfig(new Date('2026-04-30T12:00:00.000Z'));
    assert('defaults lookback to 14 days', config.lookbackDays === 14, JSON.stringify(config));
    assert('defaults max per source to 120', config.maxPerSource === 120, JSON.stringify(config));
    assert('calculates cutoff ISO', config.cutoffIso === '2026-04-16T12:00:00.000Z', config.cutoffIso);
  }

  {
    process.env.INBOX_LOOKBACK_DAYS = '21';
    process.env.INBOX_MAX_PER_SOURCE = '75';
    const config = getInboxFetchConfig(new Date('2026-04-30T00:00:00.000Z'));
    assert('uses configured lookback days', config.lookbackDays === 21, JSON.stringify(config));
    assert('uses configured max per source', config.maxPerSource === 75, JSON.stringify(config));
  }

  {
    process.env.INBOX_LOOKBACK_DAYS = '0';
    process.env.INBOX_MAX_PER_SOURCE = '-5';
    const config = getInboxFetchConfig(new Date('2026-04-30T00:00:00.000Z'));
    assert('rejects invalid lookback days', config.lookbackDays === 14, JSON.stringify(config));
    assert('rejects invalid max per source', config.maxPerSource === 120, JSON.stringify(config));
  }

  console.log('\nfetchJGMS');

  {
    const fetchCalls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).includes('/oauth2/v2.0/token')) {
        return { json: async () => ({ access_token: 'graph-token' }) };
      }
      if (fetchCalls.length === 2) {
        return {
          ok: true,
          json: async () => ({
            value: [
              {
                id: 'alpha-12345678901234567890',
                subject: 'Lead one',
                from: { emailAddress: { name: 'Pat Example', address: 'pat@example.com' } },
                receivedDateTime: '2026-04-29T10:00:00.000Z',
                bodyPreview: 'Need urgent help with custody. Call 0412 345 678.',
              },
              {
                id: 'beta-12345678901234567890',
                subject: 'Lead two',
                from: { emailAddress: { name: 'Sam Example', address: 'sam@example.com' } },
                receivedDateTime: '2026-04-28T10:00:00.000Z',
                bodyPreview: 'Second message preview',
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'gamma-12345678901234567890',
              subject: 'Lead three',
              from: { emailAddress: { name: 'Lee Example', address: 'lee@example.com' } },
              receivedDateTime: '2026-04-27T10:00:00.000Z',
              bodyPreview: 'Third message preview',
            },
          ],
        }),
      };
    };

    const emails = await fetchJGMS({
      clientId: 'client',
      tenantId: 'tenant',
      clientSecret: 'secret',
      email: 'mailbox@example.com',
      label: 'JGMS',
      cutoffIso: '2026-04-16T00:00:00.000Z',
      maxPerSource: 3,
    });

    global.fetch = realFetch;

    const firstGraphUrl = new URL(fetchCalls[1].url);
    assert('requests auth token once', fetchCalls[0].url.includes('/oauth2/v2.0/token'));
    assert('applies Graph lookback filter', firstGraphUrl.searchParams.get('$filter') === 'receivedDateTime ge 2026-04-16T00:00:00.000Z', firstGraphUrl.toString());
    assert('orders Graph messages newest-first', firstGraphUrl.searchParams.get('$orderby') === 'receivedDateTime desc', firstGraphUrl.toString());
    assert('selects minimal Graph fields', firstGraphUrl.searchParams.get('$select') === 'id,subject,from,receivedDateTime,bodyPreview', firstGraphUrl.toString());
    assert('paginates Graph until max', fetchCalls.some((call) => call.url === 'https://graph.microsoft.com/v1.0/next-page'));
    assert('caps Graph results at max per source', emails.length === 3, `count=${emails.length}`);
    assert('keeps snippet minimised/redacted', !emails[0].snippet.includes('0412'), emails[0].snippet);
  }

  console.log('\nfetchIMAP');

  {
    const state = {
      opened: null,
      locked: null,
      searched: null,
      fetched: null,
      loggedOut: false,
    };
    const parsedBodies = new Map([
      ['raw-2', { from: { value: [{ name: 'Oldest', address: 'oldest@example.com' }] }, text: 'Oldest body', subject: 'Older', date: new Date('2026-04-20T10:00:00.000Z') }],
      ['raw-3', { from: { value: [{ name: 'Middle', address: 'middle@example.com' }] }, text: 'Middle body', subject: 'Middle', date: new Date('2026-04-21T10:00:00.000Z') }],
      ['raw-4', { from: { value: [{ name: 'Newest', address: 'newest@example.com' }] }, text: 'Newest body', subject: 'Newest', date: new Date('2026-04-22T10:00:00.000Z') }],
    ]);

    inbox._test.simpleParserRef.current = async (source) => parsedBodies.get(String(source));
    inbox._test.ImapFlowRef.current = class StubImapFlow {
      async connect() {}
      async mailboxOpen(pathName, options) {
        state.opened = { pathName, options };
        this.mailbox = { exists: 4 };
      }
      async getMailboxLock(pathName) {
        state.locked = pathName;
        return { release() {} };
      }
      async search(query) {
        state.searched = query;
        return [1, 2, 3, 4];
      }
      async *fetch(uids) {
        state.fetched = uids;
        for (const uid of uids) {
          yield { uid, source: `raw-${uid}` };
        }
      }
      async logout() {
        state.loggedOut = true;
      }
    };

    const emails = await fetchIMAP({
      host: 'mail.example.com',
      port: 993,
      user: 'user',
      pass: 'pass',
      label: 'FLA',
      mailboxKey: 'fla',
      cutoffDate: new Date('2026-04-16T00:00:00.000Z'),
      maxPerSource: 3,
    });

    assert('opens IMAP inbox readonly', state.opened && state.opened.pathName === 'INBOX' && state.opened.options && state.opened.options.readOnly === true, JSON.stringify(state.opened));
    assert('locks INBOX before fetch', state.locked === 'INBOX', state.locked);
    assert('searches IMAP by SINCE cutoff', state.searched && state.searched.since instanceof Date && state.searched.since.toISOString() === '2026-04-16T00:00:00.000Z', JSON.stringify(state.searched));
    assert('fetches only newest max per source', JSON.stringify(state.fetched) === JSON.stringify([2, 3, 4]), JSON.stringify(state.fetched));
    assert('returns newest-first IMAP emails', emails.map((email) => email.subject).join(',') === 'Newest,Middle,Older', emails.map((email) => email.subject).join(','));
    assert('logs out after IMAP fetch', state.loggedOut === true);
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  Module._load = realLoad;
  console.error(err);
  process.exit(1);
});
