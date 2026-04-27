// Server-side email privacy utilities for LeadFlow.
// Provides data minimisation, PII redaction, prompt-injection detection,
// and the JSON extraction contract for any future LLM integration.
//
// IMPORTANT: emails are untrusted input. Never pass raw email content to an LLM
// without running it through minimiseBody → detectInjection → redactPii first.
// Human review is required before acting on any LLM-extracted data.

'use strict';

// ── Prompt-injection detection ─────────────────────────────────────────────────
// Checks for patterns that attempt to override LLM instructions.
// Call this on any minimised snippet before building an LLM prompt.
// If injection_risk is true, discard the input and log the event — do NOT send.
const INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|all)\s+instructions/i,
  /forget\s+(everything|all\s+(?:previous|prior))/i,
  /you\s+are\s+now\s+(?:a|an)\b/i,
  /\bact\s+as\b/i,
  /\bjailbreak\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  /\bdisregard\s+(?:all|previous|prior)\b/i,
  /\boverride\s+(?:all|your|the)\b/i,
  /\bsystem\s+prompt\b/i,
  /\bsystem\s*:\s*\[/i,
  /\[INST\]/i,
  /<\|(?:im_start|system|user|assistant)\|>/i,
  /\bnow\s+translate\s+(?:this|everything)\s+to\b/i,
  /\bdo\s+not\s+follow\b/i,
];

/**
 * Scans text for prompt-injection patterns.
 * @param {string} text
 * @returns {{ injection_risk: boolean, matched_patterns: string[] }}
 */
function detectInjection(text) {
  if (!text) return { injection_risk: false, matched_patterns: [] };
  const matched = INJECTION_PATTERNS
    .filter((p) => p.test(text))
    .map((p) => p.source);
  return { injection_risk: matched.length > 0, matched_patterns: matched };
}

// ── PII redaction ─────────────────────────────────────────────────────────────
// Replaces identifiable data with typed placeholders before LLM processing.
// The original (un-redacted) data stays in Supabase; only minimised+redacted
// text is ever submitted to an LLM.
const PII_RULES = [
  // Australian mobile: 04xx xxx xxx / +614xx xxx xxx
  { pattern: /(?:(?:\+61\s*4|04)\d{2}[\s\-]?\d{3}[\s\-]?\d{3})/g, tag: '[phone-mobile]' },
  // Australian landline: 0[2378]xxxx xxxx / +61[2378]xxxx xxxx
  { pattern: /(?:(?:\+61\s*[2378]|0[2378])\d{4}[\s\-]?\d{4})/g, tag: '[phone-landline]' },
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, tag: '[email]' },
  // URLs (http/https)
  { pattern: /https?:\/\/[^\s<>"']+/g, tag: '[url]' },
  // ABN — 11 digits with optional spaces (e.g. 12 345 678 901)
  { pattern: /\b\d{2}\s\d{3}\s\d{3}\s\d{3}\b/g, tag: '[abn]' },
  // TFN — 9 digits with optional spaces/hyphens (e.g. 123 456 789)
  { pattern: /\b\d{3}[\s\-]\d{3}[\s\-]\d{3}\b/g, tag: '[tfn-or-id]' },
];

/**
 * Redacts PII from text with typed placeholders.
 * @param {string} text
 * @returns {{ redacted: string, redacted_pii: boolean }}
 */
function redactPii(text) {
  if (!text) return { redacted: '', redacted_pii: false };
  let result = text;
  let changed = false;
  for (const { pattern, tag } of PII_RULES) {
    const next = result.replace(pattern, tag);
    if (next !== result) { changed = true; result = next; }
  }
  return { redacted: result, redacted_pii: changed };
}

// ── Email body minimisation ───────────────────────────────────────────────────
// Strips quoted replies and signature blocks, collapses whitespace, and truncates.
// maxLength default is 300 chars — sufficient for matter-type classification
// without exposing case detail.
const REPLY_MARKER = /(\r?\n)[ \t]*>[ \t]?|^\s*On\s.+\swrote:\s*$/im;
const SIGNATURE_MARKER = /(\r?\n)[\s\-–—]*(?:regards|sincerely|cheers|thanks|kind regards|best regards|warm regards|yours faithfully|yours sincerely|sent from)[,\s]/i;

/**
 * Returns a minimal safe text representation of an email body.
 * @param {string} text  Raw plain-text body
 * @param {number} maxLength  Hard truncation limit (default 300)
 * @returns {string}
 */
function minimiseBody(text, maxLength = 300) {
  if (!text) return '';
  let body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip quoted reply content
  const replyIdx = body.search(REPLY_MARKER);
  if (replyIdx > 0) body = body.slice(0, replyIdx);
  // Strip email signature
  const sigIdx = body.search(SIGNATURE_MARKER);
  if (sigIdx > 0) body = body.slice(0, sigIdx);
  return body.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// ── LLM extraction contract ───────────────────────────────────────────────────
// Defines the ONLY fields an LLM may return when processing a minimised email.
// The caller must validate LLM output against this schema before storing or
// displaying any extracted data. requires_human_review must always be true.
const LLM_EXTRACTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'LeadFlow LLM Extraction Output',
  description:
    'Fields an LLM may extract from a minimised, redacted email snippet. ' +
    'Human review is required before acting on any extracted field.',
  type: 'object',
  required: ['matter_type_guess', 'urgency_guess', 'requires_human_review', 'human_review_warning'],
  additionalProperties: false,
  properties: {
    matter_type_guess: {
      type: 'string',
      enum: ['family_law', 'property', 'criminal', 'estate', 'employment', 'immigration', 'other', 'unclear'],
      description: 'Best-guess matter type. Treat as a triage hint only.',
    },
    urgency_guess: {
      type: 'string',
      enum: ['urgent', 'standard', 'unclear'],
    },
    location_mentioned: {
      type: ['string', 'null'],
      maxLength: 80,
      description: 'State or territory only — no street addresses.',
    },
    requires_human_review: {
      type: 'boolean',
      const: true,
      description: 'Always true. LLM output must not be actioned without human review.',
    },
    human_review_warning: {
      type: 'string',
      description: 'Warning shown to the practitioner before acting on this output.',
    },
  },
};

// ── Safe LLM input builder ────────────────────────────────────────────────────
// Builds the minimal, redacted payload suitable for an LLM prompt.
// Returns { safe: false } if injection risk detected — caller must discard
// the email and log the event rather than proceeding.
//
// Usage:
//   const result = buildLlmInput({ body, subject, source_label });
//   if (!result.safe) { audit('llm.injection_blocked', ...); return; }
//   // submit result.llm_input to the LLM
/**
 * @param {{ body?: string, snippet?: string, subject?: string, source_label?: string }} email
 * @returns {{ safe: boolean, injection_risk: boolean, matched_patterns?: string[], redacted_pii?: boolean, llm_input?: object }}
 */
function buildLlmInput(email) {
  const rawText = email.body || email.snippet || '';
  const minimised = minimiseBody(rawText, 300);
  const { injection_risk, matched_patterns } = detectInjection(minimised);
  if (injection_risk) {
    return { safe: false, injection_risk: true, matched_patterns, llm_input: null };
  }
  const { redacted, redacted_pii } = redactPii(minimised);
  return {
    safe: true,
    injection_risk: false,
    redacted_pii,
    llm_input: {
      subject: redactPii((email.subject || '').slice(0, 120)).redacted,
      snippet: redacted,
      source_label: email.source_label || '',
    },
  };
}

/**
 * Validates LLM output against the extraction schema.
 * Returns { valid: boolean, errors: string[] }.
 * Always rejects output that sets requires_human_review to anything other than true.
 * @param {object} output  Parsed JSON from LLM
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLlmOutput(output) {
  const errors = [];
  if (!output || typeof output !== 'object') {
    return { valid: false, errors: ['Output is not an object'] };
  }
  const allowedMatterTypes = LLM_EXTRACTION_SCHEMA.properties.matter_type_guess.enum;
  const allowedUrgency = LLM_EXTRACTION_SCHEMA.properties.urgency_guess.enum;
  if (!allowedMatterTypes.includes(output.matter_type_guess)) {
    errors.push(`matter_type_guess must be one of: ${allowedMatterTypes.join(', ')}`);
  }
  if (!allowedUrgency.includes(output.urgency_guess)) {
    errors.push(`urgency_guess must be one of: ${allowedUrgency.join(', ')}`);
  }
  if (output.requires_human_review !== true) {
    errors.push('requires_human_review must be true — LLM output must not be actioned without human review');
  }
  if (!output.human_review_warning || typeof output.human_review_warning !== 'string') {
    errors.push('human_review_warning is required');
  }
  if (output.location_mentioned !== undefined && output.location_mentioned !== null) {
    if (typeof output.location_mentioned !== 'string') {
      errors.push('location_mentioned must be a string or null');
    } else if (output.location_mentioned.length > 80) {
      errors.push('location_mentioned exceeds 80 characters');
    }
  }
  const allowedKeys = Object.keys(LLM_EXTRACTION_SCHEMA.properties);
  const extraKeys = Object.keys(output).filter((k) => !allowedKeys.includes(k));
  if (extraKeys.length > 0) {
    errors.push(`Unexpected fields in LLM output: ${extraKeys.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  detectInjection,
  redactPii,
  minimiseBody,
  buildLlmInput,
  validateLlmOutput,
  LLM_EXTRACTION_SCHEMA,
};
