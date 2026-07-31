/** courier.test.js — plain node. */
'use strict';
const assert = require('assert');
const c = require('./courier');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); failed++; }
}
console.log('\nCourier logic\n');

const goodDelivery = {
  parcel_size: 'small', parcel_desc: 'documents',
  recipient_name: 'Tendai', recipient_phone: '+263771234567',
};

test('valid delivery details pass', () => {
  assert.strictEqual(c.validateDeliveryDetails(goodDelivery).ok, true);
});
test('bad parcel size rejected', () => {
  assert.strictEqual(c.validateDeliveryDetails({ ...goodDelivery, parcel_size: 'huge' }).reason, 'invalid_parcel_size');
});
test('missing desc rejected', () => {
  assert.strictEqual(c.validateDeliveryDetails({ ...goodDelivery, parcel_desc: '' }).reason, 'parcel_desc_required');
});
test('missing recipient name rejected', () => {
  assert.strictEqual(c.validateDeliveryDetails({ ...goodDelivery, recipient_name: '' }).reason, 'recipient_name_required');
});
test('missing recipient phone rejected', () => {
  assert.strictEqual(c.validateDeliveryDetails({ ...goodDelivery, recipient_phone: '' }).reason, 'recipient_phone_required');
});

test('handover code is 4 digits', () => {
  for (let i = 0; i < 100; i++) assert.ok(/^\d{4}$/.test(c.generateHandoverCode()));
});

// canMarkDelivered
const code = '4821';
const trip = { status: 'in_progress', delivery_code_hash: c.hashCode(code) };

test('delivered with correct code', () => {
  const r = c.canMarkDelivered(trip, { code });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.method, 'code');
});
test('delivered with photo fallback', () => {
  const r = c.canMarkDelivered(trip, { hasDeliveryPhoto: true });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.method, 'photo');
});
test('wrong code and no photo -> rejected', () => {
  assert.strictEqual(c.canMarkDelivered(trip, { code: '0000' }).reason, 'need_code_or_delivery_photo');
});
test('cannot deliver a trip not in progress', () => {
  assert.strictEqual(c.canMarkDelivered({ status: 'driver_assigned' }, { code }).reason, 'trip_not_in_progress');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
