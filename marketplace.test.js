/** marketplace.test.js — plain node, no framework. */
'use strict';
const assert = require('assert');
const m = require('./marketplace');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); failed++; }
}

console.log('\nMarketplace logic\n');

// ---- validateFare ----
test('normal fare ok', () => assert.strictEqual(m.validateFare(5).ok, true));
test('zero fare rejected', () => assert.strictEqual(m.validateFare(0).reason, 'fare_too_low'));
test('huge fare rejected', () => assert.strictEqual(m.validateFare(99999).reason, 'fare_too_high'));
test('non-number fare rejected', () => assert.strictEqual(m.validateFare('5').reason, 'fare_not_a_number'));
test('NaN fare rejected', () => assert.strictEqual(m.validateFare(NaN).reason, 'fare_not_a_number'));

// ---- validateLngLat ----
test('Harare coords ok', () => assert.strictEqual(m.validateLngLat(31.05, -17.83).ok, true));
test('out-of-range lng rejected', () => assert.strictEqual(m.validateLngLat(200, 0).reason, 'lng_out_of_range'));
test('out-of-range lat rejected', () => assert.strictEqual(m.validateLngLat(0, 200).reason, 'lat_out_of_range'));
test('string coords rejected', () => assert.strictEqual(m.validateLngLat('31', '-17').reason, 'coords_not_numbers'));

// ---- isSessionLive (ghost-session guard) ----
test('fresh online session is live', () => {
  assert.strictEqual(m.isSessionLive({ is_online: true, last_seen_at: new Date().toISOString() }), true);
});
test('stale session (>30s) is NOT live', () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(m.isSessionLive({ is_online: true, last_seen_at: old }), false);
});
test('offline session is NOT live', () => {
  assert.strictEqual(m.isSessionLive({ is_online: false, last_seen_at: new Date().toISOString() }), false);
});
test('null session is NOT live', () => {
  assert.strictEqual(m.isSessionLive(null), false);
});

// ---- validateOffer ----
test('offer on open request ok', () => {
  assert.strictEqual(m.validateOffer({ status: 'open', proposed_fare: 5 }, 6).ok, true);
});
test('offer on matched request rejected', () => {
  assert.strictEqual(m.validateOffer({ status: 'matched' }, 6).reason, 'request_not_open');
});
test('offer with bad fare rejected', () => {
  assert.strictEqual(m.validateOffer({ status: 'open' }, 0).reason, 'fare_too_low');
});
test('offer on missing request rejected', () => {
  assert.strictEqual(m.validateOffer(null, 6).reason, 'request_not_found');
});

// ---- tripTransition ----
test('driver_assigned -> arrived ok', () => {
  assert.strictEqual(m.tripTransition('driver_assigned', 'arrived'), 'arrived');
});
test('arrived -> in_progress -> completed chain ok', () => {
  assert.strictEqual(m.tripTransition('arrived', 'in_progress'), 'in_progress');
  assert.strictEqual(m.tripTransition('in_progress', 'completed'), 'completed');
});
test('cannot skip from driver_assigned to completed', () => {
  assert.throws(() => m.tripTransition('driver_assigned', 'completed'), m.InvalidTripTransition);
});
test('cannot transition out of completed', () => {
  assert.throws(() => m.tripTransition('completed', 'in_progress'), m.InvalidTripTransition);
});
test('any state can cancel (except terminal)', () => {
  assert.strictEqual(m.tripTransition('driver_assigned', 'cancelled'), 'cancelled');
  assert.strictEqual(m.tripTransition('in_progress', 'cancelled'), 'cancelled');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
