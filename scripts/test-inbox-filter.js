#!/usr/bin/env node
// Tests for api/lib/lead-filter.js (inbox relevance scoring).
// Run: node scripts/test-inbox-filter.js
// Exits 0 on pass, 1 on any failure.

'use strict';

const path = require('path');
const { isSystemEmail, scoreEmail } = require(path.join(__dirname, '..', 'api', 'lib', 'lead-filter'));

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

// Helpers
const show = (email, name, subj) => !isSystemEmail(email, name, subj);
const hide = (email, name, subj) =>  isSystemEmail(email, name, subj);

// ── Protected lead domains: always show ───────────────────────────────────────

console.log('\nProtected lead domains (always show)');

assert('Legal Aid NSW shows', show('grants@legalaid.nsw.gov.au', 'Legal Aid NSW', 'Grant of Aid approval'));
assert('LawConnect shows', show('referral@lawconnect.com.au', 'LawConnect', 'New client referral'));
assert('Finchly shows', show('intake@finchly.com.au', 'Finchly', 'New enquiry received'));
assert('SMS forwarder shows', show('sms@forward-sms.app', 'Forward SMS', 'SMS from 0412 345 678'));
assert('NT Legal Aid shows', show('case@legalaid.nt.gov.au', 'NT Legal Aid', 'New matter'));
assert('NAAJA shows', show('referral@naaja.com.au', 'NAAJA', 'Referral - criminal matter'));

// ── The specific examples from the reported issue ─────────────────────────────

console.log('\nReported problem cases (must be hidden)');

assert('Bryan Johnson newsletter hidden',
  hide('hello@bryanjohnson.com', 'Bryan Johnson', 'my oral hygiene protocol (2026)'));

assert('InfoTrack sync update hidden',
  hide('notifications@infotrack.com.au', 'InfoTrack Litigation', 'Family Court - Sync Update'));

assert('PythonAnywhere support hidden',
  hide('support@pythonanywhere.com', 'PythonAnywhere Support', 'Your PythonAnywhere invoice'));

// ── Blocked operational domains ───────────────────────────────────────────────

console.log('\nBlocked operational domains');

assert('Vercel deployment hidden', hide('noreply@vercel.com', 'Vercel', 'Deployment succeeded'));
assert('GitHub notification hidden', hide('noreply@github.com', 'GitHub', '[GitHub] PR review'));
assert('Supabase alert hidden', hide('noreply@supabase.com', 'Supabase', 'Sign in to Supabase'));
assert('Stripe receipt hidden', hide('receipts@stripe.com', 'Stripe', 'Your payment receipt'));
assert('Xero invoice hidden', hide('noreply@xero.com', 'Xero', 'Your Xero invoice'));
assert('Mailchimp newsletter hidden', hide('campaign@mailchimp.com', 'Mailchimp', 'Weekly digest'));
assert('Klaviyo hidden', hide('hello@klaviyo.com', 'Sender', 'New email for you'));
assert('HubSpot hidden', hide('info@hubspot.com', 'HubSpot', 'New lead from web form'));
assert('Substack newsletter hidden', hide('hello@substack.com', 'Substack', 'New post from author'));
assert('Zoom meeting invitation hidden', hide('no-reply@zoom.us', 'Zoom', 'Zoom meeting invitation'));
assert('LinkedIn hidden', hide('messages@linkedin.com', 'LinkedIn', 'You have a new connection'));
assert('Leap legal software hidden', hide('admin@leap.com.au', 'LEAP', 'LEAP: System update'));

// InfoTrack must be hidden even when subject contains "court" (ordering fix)
assert('InfoTrack blocked domain wins over legal subject',
  hide('sync@infotrack.com.au', 'InfoTrack', 'Federal Circuit Court - Sync Update'));

// ── Blocked automated local-parts ────────────────────────────────────────────

console.log('\nBlocked automated local-parts');

assert('noreply@ hidden', hide('noreply@example.com.au', '', 'Hello'));
assert('no-reply@ hidden', hide('no-reply@example.com.au', '', 'Hello'));
assert('notifications@ hidden', hide('notifications@example.com.au', '', 'Hello'));
assert('billing@ hidden', hide('billing@example.com.au', '', 'Your billing summary'));
assert('newsletter@ hidden', hide('newsletter@example.com.au', '', 'This week in news'));
assert('noreply+tag@ variant hidden', hide('noreply+123@example.com.au', '', 'Hello'));

// ── Noise subject signals ─────────────────────────────────────────────────────

console.log('\nNoise subject signals (non-blocked domain but clear noise)');

assert('Unsubscribe subject hidden', hide('info@somesite.com', 'SomeSite', 'Unsubscribe from our list'));
assert('Newsletter digest hidden', hide('updates@somesite.com', 'SomeSite', 'Weekly digest - issue #42'));
assert('Sync update subject hidden', hide('admin@somesite.com', 'App', 'Sync update complete'));
assert('Subscription renewal hidden', hide('admin@somesite.com', 'App', 'Your subscription renewal'));
assert('Order confirmation hidden', hide('orders@shop.com', 'Shop', 'Your order confirmation #1234'));

// ── Real lead patterns: must show ─────────────────────────────────────────────

console.log('\nReal lead/client patterns (must show)');

assert('Family law enquiry shows', show('client@gmail.com', 'Jane Smith', 'Family law enquiry'));
assert('Divorce help shows', show('person@hotmail.com', 'John Doe', 'Need help with divorce'));
assert('Criminal matter shows', show('client@outlook.com', 'Alex Brown', 'Criminal matter - urgent'));
assert('Legal advice shows', show('enquiry@someone.com', 'Pat Lee', 'Seeking legal advice'));
assert('Referral shows', show('case@partner.com.au', 'Partner Firm', 'Referral - new client'));
assert('DVO matter shows', show('client@yahoo.com', 'Client', 'DVO application - need help'));
assert('Consent orders shows', show('user@icloud.com', 'User', 'Consent orders question'));
assert('SMS from shows', show('forward@forward-sms.app', 'SMS Forwarder', 'SMS from 0400 111 222'));

// ── Neutral unknown senders: show by default ──────────────────────────────────

console.log('\nNeutral/unknown senders (conservative — show by default)');

assert('Unknown sender with generic subject shows', show('someone@unknown.com', 'Someone', 'Hello'));
assert('Generic hello shows', show('info@randomfirm.com.au', 'Random Firm', 'Hello there'));

// ── scoreEmail boundary tests ─────────────────────────────────────────────────

console.log('\nscoreEmail boundaries');

const protectedScore = scoreEmail('grant@legalaid.nsw.gov.au', 'Legal Aid', 'Grant approved');
assert('Protected lead domain returns score >= 100', protectedScore >= 100);

const blockedScore = scoreEmail('sync@infotrack.com.au', 'InfoTrack', 'Family Court Sync');
assert('Blocked operational domain returns score <= -100', blockedScore <= -100);

const leadSubjScore = scoreEmail('person@gmail.com', '', 'Family law hearing next week');
assert('Lead subject signal returns positive score', leadSubjScore > 0);

const noiseSubjScore = scoreEmail('person@gmail.com', '', 'Unsubscribe from weekly digest');
assert('Noise subject signal returns negative score', noiseSubjScore < 0);

const neutralScore = scoreEmail('person@gmail.com', '', 'Hello');
assert('Neutral email returns 0 (show by default)', neutralScore === 0);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
