/**
 * driver-kyc.test.js — runs with plain `node`, no test framework needed.
 * Verifies the rules that keep unverified drivers off the road.
 */
'use strict';

const assert = require('assert');
const kyc = require('./driver-kyc');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); failed++; }
}

const HOUR = 60 * 60 * 1000;
const passedDoc = (kind, extra = {}) => ({ kind, status: 'passed', ...extra });

console.log('\nDriver KYC state machine\n');

// ---- transitions ----
test('registered -> documents_pending is allowed', () => {
  assert.strictEqual(kyc.transition('registered', 'documents_pending'), 'documents_pending');
});

test('registered -> approved is REJECTED (cannot skip review)', () => {
  assert.throws(() => kyc.transition('registered', 'approved'), kyc.InvalidTransitionError);
});

test('under_review -> approved is allowed', () => {
  assert.strictEqual(kyc.transition('under_review', 'approved'), 'approved');
});

test('approved -> suspended is allowed; approved -> registered is not', () => {
  assert.strictEqual(kyc.transition('approved', 'suspended'), 'suspended');
  assert.throws(() => kyc.transition('approved', 'registered'), kyc.InvalidTransitionError);
});

// ---- approval readiness ----
test('all required docs present -> ready', () => {
  const docs = [
    passedDoc('national_id'),
    passedDoc('drivers_licence'),
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
    passedDoc('police_clearance'),
  ];
  const r = kyc.evaluateApprovalReadiness(docs);
  assert.strictEqual(r.ready, true, JSON.stringify(r.missing));
});

test('passport satisfies the identity requirement instead of national_id', () => {
  const docs = [
    passedDoc('passport'),
    passedDoc('drivers_licence'),
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
    passedDoc('police_clearance'),
  ];
  assert.strictEqual(kyc.evaluateApprovalReadiness(docs).ready, true);
});

test('missing police clearance -> not ready', () => {
  const docs = [
    passedDoc('national_id'),
    passedDoc('drivers_licence'),
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
  ];
  const r = kyc.evaluateApprovalReadiness(docs);
  assert.strictEqual(r.ready, false);
  assert.ok(r.missing.includes('police_clearance'));
});

test('an EXPIRED licence does not count as passed', () => {
  const yesterday = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
  const docs = [
    passedDoc('national_id'),
    passedDoc('drivers_licence', { expires_on: yesterday }), // expired
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
    passedDoc('police_clearance'),
  ];
  const r = kyc.evaluateApprovalReadiness(docs);
  assert.strictEqual(r.ready, false);
  assert.ok(r.missing.includes('drivers_licence'));
});

// ---- face check ----
test('face score above threshold passes; below fails', () => {
  assert.strictEqual(kyc.evaluateFaceCheck(0.95).status, 'passed');
  assert.strictEqual(kyc.evaluateFaceCheck(0.50).status, 'failed');
});

test('garbage face score fails safely', () => {
  assert.strictEqual(kyc.evaluateFaceCheck(NaN).status, 'failed');
  assert.strictEqual(kyc.evaluateFaceCheck(undefined).status, 'failed');
});

// ---- can go online ----
test('approved driver with fresh passed face check can go online', () => {
  const r = kyc.canGoOnline(
    { status: 'approved' },
    { status: 'passed', checked_at: new Date().toISOString() }
  );
  assert.strictEqual(r.allowed, true);
});

test('approved driver with NO face check is blocked', () => {
  const r = kyc.canGoOnline({ status: 'approved' }, null);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'face_check_required');
});

test('stale face check (>12h) is blocked', () => {
  const old = new Date(Date.now() - 13 * HOUR).toISOString();
  const r = kyc.canGoOnline({ status: 'approved' }, { status: 'passed', checked_at: old });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'face_check_expired');
});

test('un-approved driver cannot go online even with a passed face check', () => {
  const r = kyc.canGoOnline(
    { status: 'under_review' },
    { status: 'passed', checked_at: new Date().toISOString() }
  );
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'driver_not_approved');
});

// ---- regression: identity fallback + timezone boundary ----

test('expired national_id but VALID passport still satisfies identity', () => {
  const yest = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
  const docs = [
    passedDoc('national_id', { expires_on: yest }), // expired
    passedDoc('passport'),                          // valid, no expiry given
    passedDoc('drivers_licence'),
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
    passedDoc('police_clearance'),
  ];
  const r = kyc.evaluateApprovalReadiness(docs);
  assert.strictEqual(r.ready, true, JSON.stringify(r.missing));
});

test('BOTH identity docs expired -> identity missing', () => {
  const yest = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
  const docs = [
    passedDoc('national_id', { expires_on: yest }),
    passedDoc('passport', { expires_on: yest }),
    passedDoc('drivers_licence'),
    passedDoc('vehicle_registration'),
    passedDoc('roadworthiness'),
    passedDoc('insurance'),
    passedDoc('police_clearance'),
  ];
  const r = kyc.evaluateApprovalReadiness(docs);
  assert.strictEqual(r.ready, false);
  assert.ok(r.missing.some((m) => m.includes('identity')));
});

test('licence is valid THROUGH its expiry day in Harare (no early-expiry bug)', () => {
  // 2026-06-08 09:00 CAT == 2026-06-08 07:00 UTC.
  const nineAmHarare = new Date('2026-06-08T07:00:00Z');
  const doc = { kind: 'drivers_licence', status: 'passed', expires_on: '2026-06-08' };
  assert.strictEqual(kyc.isExpired(doc, nineAmHarare), false, 'should still be valid on expiry day');
});

test('licence IS expired the day after, in Harare', () => {
  const nextDay = new Date('2026-06-09T07:00:00Z'); // 09:00 CAT on the 9th
  const doc = { kind: 'drivers_licence', status: 'passed', expires_on: '2026-06-08' };
  assert.strictEqual(kyc.isExpired(doc, nextDay), true);
});

test('isExpired accepts a full ISO timestamp string too', () => {
  const doc = { kind: 'insurance', status: 'passed', expires_on: '2020-01-01T00:00:00Z' };
  assert.strictEqual(kyc.isExpired(doc), true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);