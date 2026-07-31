/**
 * phone-auth.js — pure logic for phone signup / OTP verification.
 *
 * No database, no network here — just the rules. The endpoints in the
 * signup route call these, then persist via Supabase. Keeping the rules
 * pure means we can unit-test them with zero infrastructure (same pattern
 * as driver-kyc.js).
 */
'use strict';

const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;  // codes valid for 10 minutes
const MAX_ATTEMPTS = 5;              // wrong guesses before a code is dead

/**
 * Normalise a phone number toward E.164 for Zimbabwe (+263).
 * Accepts common local formats and returns +263XXXXXXXXX, or null if it
 * doesn't look like a valid Zimbabwean mobile number.
 *
 *   0771234567      -> +263771234567
 *   263771234567    -> +263771234567
 *   +263771234567   -> +263771234567
 *   771234567       -> +263771234567
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s\-()]/g, ''); // strip spaces, dashes, brackets

  if (s.startsWith('+263')) s = s.slice(4);
  else if (s.startsWith('263')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);

  // Zimbabwe mobile numbers are 9 digits after the country code,
  // starting with 7 (e.g. 71/77/78 Econet, 73 NetOne, etc.)
  if (!/^7\d{8}$/.test(s)) return null;

  return '+263' + s;
}

/** Generate a random 6-digit code as a string ('000000'..'999999'). */
function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Hash a code for storage. We never store the raw code. */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** When does a freshly created code expire? */
function expiryFrom(now = new Date()) {
  return new Date(now.getTime() + CODE_TTL_MS);
}

/**
 * Decide whether a submitted code is acceptable, given the stored record.
 * `record` is the latest phone_verifications row (or null if none).
 * Returns { ok: boolean, reason: string|null }.
 */
function verifyCode(record, submittedCode, now = new Date()) {
  if (!record) return { ok: false, reason: 'no_code_found' };
  if (record.consumed_at) return { ok: false, reason: 'code_already_used' };
  if (new Date(record.expires_at) < now) return { ok: false, reason: 'code_expired' };
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const matches = hashCode(submittedCode) === record.code_hash;
  if (!matches) return { ok: false, reason: 'code_incorrect' };

  return { ok: true, reason: null };
}

module.exports = {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  normalizePhone,
  generateCode,
  hashCode,
  expiryFrom,
  verifyCode,
};
