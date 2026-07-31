/**
 * marketplace.js — pure logic for the bid-based ride marketplace.
 *
 * No DB, no network — just the rules, so they're unit-testable. The routes
 * call these, then persist via Supabase.
 */
'use strict';

// A driver session is only "live" for matching if seen recently. This is the
// ghost-session guard: phones that died / lost signal without closing their
// session must NOT receive ride requests.
const SESSION_FRESH_MS = 30 * 1000; // 30 seconds

// Trip requests stay open for offers for this long.
const REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Sanity bounds on fares (USD). Stops typos / abuse like $0 or $99999 rides.
const MIN_FARE = 0.50;
const MAX_FARE = 1000;

// How far out we look for drivers, in metres.
const MATCH_RADIUS_M = 5000;

/** Validate a rider's proposed fare. Returns { ok, reason }. */
function validateFare(fare) {
  if (typeof fare !== 'number' || Number.isNaN(fare)) return { ok: false, reason: 'fare_not_a_number' };
  if (fare < MIN_FARE) return { ok: false, reason: 'fare_too_low' };
  if (fare > MAX_FARE) return { ok: false, reason: 'fare_too_high' };
  return { ok: true, reason: null };
}

/** Validate lng/lat pair. Returns { ok, reason }. */
function validateLngLat(lng, lat) {
  if (typeof lng !== 'number' || typeof lat !== 'number') return { ok: false, reason: 'coords_not_numbers' };
  if (lng < -180 || lng > 180) return { ok: false, reason: 'lng_out_of_range' };
  if (lat < -90 || lat > 90) return { ok: false, reason: 'lat_out_of_range' };
  return { ok: true, reason: null };
}

/** Is a driver session fresh enough to receive requests? */
function isSessionLive(session, now = new Date()) {
  if (!session || !session.is_online) return false;
  if (!session.last_seen_at) return false;
  const age = now.getTime() - new Date(session.last_seen_at).getTime();
  return age <= SESSION_FRESH_MS;
}

/**
 * Validate a driver's offer on an open request.
 *   request: { status, proposed_fare }
 *   offeredFare: number (driver's price — may differ from proposed = counter)
 */
function validateOffer(request, offeredFare) {
  if (!request) return { ok: false, reason: 'request_not_found' };
  if (request.status !== 'open') return { ok: false, reason: 'request_not_open' };
  const fareCheck = validateFare(offeredFare);
  if (!fareCheck.ok) return fareCheck;
  return { ok: true, reason: null };
}

// Trip lifecycle transitions. Mirrors the trip_status enum.
const TRIP_TRANSITIONS = {
  driver_assigned: ['arrived', 'cancelled'],
  arrived:         ['in_progress', 'cancelled'],
  in_progress:     ['completed', 'cancelled'],
  completed:       [],
  cancelled:       [],
};

class InvalidTripTransition extends Error {}

function tripTransition(current, next) {
  const allowed = TRIP_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new InvalidTripTransition(`Illegal trip transition: ${current} -> ${next}`);
  }
  return next;
}

function requestExpiry(now = new Date()) {
  return new Date(now.getTime() + REQUEST_TTL_MS);
}

module.exports = {
  SESSION_FRESH_MS, REQUEST_TTL_MS, MIN_FARE, MAX_FARE, MATCH_RADIUS_M,
  validateFare, validateLngLat, isSessionLive, validateOffer,
  tripTransition, requestExpiry, InvalidTripTransition,
};
