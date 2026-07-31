/**
 * test-marketplace-flow.js — end-to-end test of the bid-based ride flow.
 * Run with the server running (npm start) in another window:
 *     node test-marketplace-flow.js
 *
 * It sets up an approved+online driver and a rider, then runs:
 *   rider requests -> driver offers -> rider accepts (fare locks)
 *   -> trip: arrived -> in_progress -> completed
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY;
const RIDER_PHONE = '0773100100';
const DRIVER_PHONE = '0773200200';
const HARARE = { lng: 31.0530, lat: -17.8250 };
const DEST = { lng: 31.0810, lat: -17.8300 };

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}  ${detail ? '-> ' + JSON.stringify(detail) : ''}`); fail++; }
}
async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

async function cleanup(phone) {
  const e164 = '+263' + phone.replace(/^0/, '');
  const { data: users } = await sb.from('users').select('id').eq('phone', e164);
  for (const u of users || []) {
    const id = u.id;
    // delete trips/requests/offers referencing this user
    const { data: reqs } = await sb.from('trip_requests').select('id').eq('rider_id', id);
    for (const r of reqs || []) {
      await sb.from('trips').delete().eq('request_id', r.id);
      await sb.from('offers').delete().eq('request_id', r.id);
    }
    await sb.from('trips').delete().eq('driver_id', id);
    await sb.from('offers').delete().eq('driver_id', id);
    await sb.from('trip_requests').delete().eq('rider_id', id);
    await sb.from('driver_sessions').delete().eq('driver_id', id);
    await sb.from('shift_face_checks').delete().eq('driver_id', id);
    await sb.from('kyc_documents').delete().eq('user_id', id);
    await sb.from('driver_profiles').delete().eq('user_id', id);
    await sb.from('rider_profiles').delete().eq('user_id', id);
    await sb.from('users').delete().eq('id', id);
  }
  await sb.from('phone_verifications').delete().eq('phone', e164);
}

async function signupUser(phone) {
  const s = await api('POST', '/signup/start', { phone });
  const v = await api('POST', '/signup/verify', { phone, code: s.json.dev_code });
  return { token: v.json.token, id: v.json.user_id, auth: { Authorization: 'Bearer ' + v.json.token } };
}

async function makeOnlineDriver(phone) {
  const d = await signupUser(phone);
  await api('POST', '/driver/register', {}, d.auth);
  for (const kind of ['national_id','drivers_licence','vehicle_registration','roadworthiness','insurance','police_clearance']) {
    await api('POST', '/driver/documents', { kind, vault_key: 'v://'+kind, status: 'passed' }, d.auth);
  }
  await api('POST', '/driver/submit-for-review', {}, d.auth);
  await api('POST', `/driver/${d.id}/approve`, {}, { 'x-admin-key': ADMIN_KEY });
  await api('POST', '/driver/face-check', { selfie_vault_key: 'v://selfie', match_score: 0.95 }, d.auth);
  await api('POST', '/driver/go-online', HARARE, d.auth);
  return d;
}

(async () => {
  console.log('\n=== Marketplace end-to-end ===\n');
  if (!ADMIN_KEY) { console.log('  (!) ADMIN_KEY missing — aborting'); process.exit(1); }

  await cleanup(RIDER_PHONE); await cleanup(DRIVER_PHONE);

  const rider = await signupUser(RIDER_PHONE);
  const driver = await makeOnlineDriver(DRIVER_PHONE);
  check('rider + online driver set up', !!rider.token && !!driver.token);

  // 1. Rider requests a ride
  const reqRes = await api('POST', '/rides/request',
    { pickup: HARARE, dropoff: DEST, proposed_fare: 6.00, pickup_label: 'CBD', dropoff_label: 'Avondale' }, rider.auth);
  check('rider creates request', reqRes.json.status === 'open', reqRes.json);
  const requestId = reqRes.json.request && reqRes.json.request.id;

  // 2. Driver sees it nearby
  const nearby = await api('GET', `/rides/nearby?lng=${HARARE.lng}&lat=${HARARE.lat}`, null, driver.auth);
  const sawIt = (nearby.json.requests || []).some((r) => r.id === requestId);
  check('driver sees request in nearby', sawIt, nearby.json);

  // 3. Driver counter-offers $7
  const offerRes = await api('POST', `/rides/${requestId}/offer`, { offered_fare: 7.00, eta_minutes: 4 }, driver.auth);
  check('driver makes offer', offerRes.json.status === 'offer_sent', offerRes.json);
  const offerId = offerRes.json.offer && offerRes.json.offer.id;

  // 4. Rider sees the offer
  const offers = await api('GET', `/rides/${requestId}/offers`, null, rider.auth);
  check('rider sees the offer', (offers.json.offers || []).some((o) => o.id === offerId), offers.json);

  // 5. Rider accepts -> fare locks at $7
  const accept = await api('POST', `/rides/${requestId}/accept`, { offer_id: offerId }, rider.auth);
  check('rider accepts -> matched', accept.json.status === 'matched', accept.json);
  check('fare locked at offered 7.00', accept.json.trip && Number(accept.json.trip.agreed_fare) === 7.00, accept.json.trip);
  const tripId = accept.json.trip && accept.json.trip.id;

  // 6. Trip lifecycle: arrived -> in_progress -> completed
  const s1 = await api('POST', `/trips/${tripId}/status`, { status: 'arrived' }, driver.auth);
  check('driver marks arrived', s1.json.status === 'arrived', s1.json);
  const s2 = await api('POST', `/trips/${tripId}/status`, { status: 'in_progress' }, driver.auth);
  check('trip in_progress', s2.json.status === 'in_progress', s2.json);
  const s3 = await api('POST', `/trips/${tripId}/status`, { status: 'completed' }, driver.auth);
  check('trip completed', s3.json.status === 'completed', s3.json);

  // 7. Illegal transition rejected
  const bad = await api('POST', `/trips/${tripId}/status`, { status: 'in_progress' }, driver.auth);
  check('cannot un-complete a trip', bad.status === 400, bad.json);

  // 8. A stranger cannot view the trip
  const stranger = await signupUser('0773999999');
  const peek = await api('GET', `/trips/${tripId}`, null, stranger.auth);
  check('stranger blocked from trip', peek.status === 403, peek.json);
  await cleanup('0773999999');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
