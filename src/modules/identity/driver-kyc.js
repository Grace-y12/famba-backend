/**
 * driver-kyc.js
 * ----------------------------------------------------------------------------
 * The driver onboarding state machine + the per-shift face-check gate.
 *
 * Why a state machine and not a pile of booleans?
 *   A driver moving cars, money, and passengers must NEVER slip into an
 *   "approved" state by accident. Encoding the allowed transitions in one
 *   place makes the rule auditable and impossible to bypass from random
 *   call sites. Every status change goes through `transition()`.
 *
 * This module is pure logic — it takes data in and returns decisions out.
 * The actual DB writes and the calls to the identity provider (Smile ID)
 * live in the repository/provider layers so this stays unit-testable with
 * zero infrastructure.
 * ----------------------------------------------------------------------------
 */

'use strict';

// Operating timezone for date-boundary comparisons (Zimbabwe = CAT, UTC+2).
// Make this configurable per-market when we expand beyond Zimbabwe.
const OPERATING_TIMEZONE = 'Africa/Harare';

// All documents a driver must have for approval (identity = national_id OR
// passport). Kept as a flat list for reference/UI; the actual rule lives in
// evaluateApprovalReadiness (identity checked as an OR, the rest individually).
const REQUIRED_DRIVER_DOCS = [
  'national_id', // OR 'passport'
  'drivers_licence',
  'vehicle_registration',
  'roadworthiness',
  'insurance',
  'police_clearance',
];

// Allowed transitions. Anything not listed here is rejected.
const ALLOWED_TRANSITIONS = {
  registered:        ['documents_pending', 'rejected'],
  documents_pending: ['under_review', 'rejected'],
  under_review:      ['approved', 'rejected', 'documents_pending'],
  approved:          ['suspended'],
  rejected:          ['documents_pending'], // allow re-application
  suspended:         ['approved', 'rejected'],
};

// Minimum face-match similarity to accept a per-shift selfie.
// Tunable; providers typically report 0..1. 0.80 is a sane starting point —
// validate against the provider's recommended threshold before launch.
const FACE_MATCH_THRESHOLD = 0.80;

// How long a passed shift face-check keeps a driver eligible to be online
// before we demand a fresh one.
const FACE_CHECK_VALIDITY_MS = 12 * 60 * 60 * 1000; // 12 hours

class InvalidTransitionError extends Error {}

/**
 * Validate and return the next status. Throws if the transition is illegal.
 */
function transition(current, next) {
  const allowed = ALLOWED_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError(
      `Illegal driver status transition: ${current} -> ${next}`
    );
  }
  return next;
}

function hasIdentityDoc(activeDocs) {
  return activeDocs.some((d) => d.kind === 'national_id' || d.kind === 'passport');
}

// Required docs OTHER than the identity doc (identity is national_id OR passport,
// checked separately). Keeping these explicit avoids the brittle "skip the
// national_id string in a loop" pattern.
const REQUIRED_NON_IDENTITY_DOCS = [
  'drivers_licence',
  'vehicle_registration',
  'roadworthiness',
  'insurance',
  'police_clearance',
];

/**
 * Decide whether a driver currently satisfies every requirement for approval.
 * `documents` is the list of that driver's kyc_documents rows.
 * Returns { ready: boolean, missing: string[] }.
 *
 * Note: we filter to live (passed + non-expired) docs FIRST, then test each
 * requirement against the survivors. So an expired national_id alongside a
 * valid passport still satisfies identity — the expired doc simply drops out.
 */
function evaluateApprovalReadiness(documents, asOf = new Date()) {
  const activeDocs = documents.filter(
    (d) => d.status === 'passed' && !isExpired(d, asOf)
  );

  const missing = [];

  if (!hasIdentityDoc(activeDocs)) {
    missing.push('identity (national_id or passport)');
  }

  for (const kind of REQUIRED_NON_IDENTITY_DOCS) {
    if (!activeDocs.some((d) => d.kind === kind)) missing.push(kind);
  }

  return { ready: missing.length === 0, missing };
}

/**
 * Is a document expired as of `asOf`?
 *
 * expires_on is a SQL DATE (no time, no zone), e.g. '2026-06-08'. We must
 * compare it to "today" in the OPERATING timezone, not UTC. Parsing the date
 * with `new Date('2026-06-08')` yields midnight UTC, which in Zimbabwe
 * (UTC+2 / CAT) would wrongly mark a licence expired from 02:00 local on its
 * own expiry day. Comparing YYYY-MM-DD strings in Africa/Harare avoids that.
 */
function isExpired(doc, asOf = new Date()) {
  if (!doc.expires_on) return false;
  // Normalise both sides to 'YYYY-MM-DD' in the operating zone.
  const today = asOf.toLocaleDateString('en-CA', { timeZone: OPERATING_TIMEZONE });
  const expiry = String(doc.expires_on).slice(0, 10); // DATE or ISO -> 'YYYY-MM-DD'
  // Expired only AFTER the expiry date passes (valid through the expiry day).
  return expiry < today;
}

/**
 * Decide the outcome of a per-shift face check.
 * `matchScore` comes back from the identity provider's 1:1 face compare
 * between the fresh selfie and the driver's reference face.
 */
function evaluateFaceCheck(matchScore) {
  if (typeof matchScore !== 'number' || Number.isNaN(matchScore)) {
    return { status: 'failed', reason: 'no_score' };
  }
  return matchScore >= FACE_MATCH_THRESHOLD
    ? { status: 'passed', reason: null }
    : { status: 'failed', reason: 'below_threshold' };
}

/**
 * Can this driver go online / accept a ride RIGHT NOW?
 * Combines: approved status + a recent passed face check.
 *
 *   driver:         { status }
 *   lastFaceCheck:  { status, checked_at } | null
 */
function canGoOnline(driver, lastFaceCheck, now = new Date()) {
  if (driver.status !== 'approved') {
    return { allowed: false, reason: 'driver_not_approved' };
  }
  if (!lastFaceCheck || lastFaceCheck.status !== 'passed') {
    return { allowed: false, reason: 'face_check_required' };
  }
  const age = now.getTime() - new Date(lastFaceCheck.checked_at).getTime();
  if (age > FACE_CHECK_VALIDITY_MS) {
    return { allowed: false, reason: 'face_check_expired' };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  REQUIRED_DRIVER_DOCS,
  REQUIRED_NON_IDENTITY_DOCS,
  OPERATING_TIMEZONE,
  FACE_MATCH_THRESHOLD,
  FACE_CHECK_VALIDITY_MS,
  InvalidTransitionError,
  transition,
  evaluateApprovalReadiness,
  evaluateFaceCheck,
  canGoOnline,
  isExpired,
};