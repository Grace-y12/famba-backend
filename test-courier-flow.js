/**
 * test-courier-flow.js — end-to-end parcel delivery.
 *   sender requests delivery -> courier offers -> sender accepts (handover
 *   code generated) -> courier: arrived -> in_progress -> pickup-proof ->
 *   deliver with handover code -> completed.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY;
const SENDER = '0774100100';
const COURIER = '0774200200';
const A = { lng: 31.0530, lat: -17.8250 };
const B = { lng: 31.0810, lat: -17.8300 };

let pass = 0, fail = 0;
function check(l, c, d) { if (c) { console.log(`  PASS  ${l}`); pass++; } else { console.log(`  FAIL  ${l}  ${d ? '-> ' + JSON.stringify(d) : ''}`); fail++; } }
async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function cleanup(phone) {
  const e164 = '+263' + phone.replace(/^0/, '');
  const { data: users } = await sb.from('users').select('id').eq('phone', e164);
  for (const u of users || []) {
    const id = u.id;
    const { data: reqs } = await sb.from('trip_requests').select('id').eq('rider_id', id);
    for (const r of reqs || []) {
      const { data: trips } = await sb.from('trips').select('id').eq('request_id', r.id);
      for (const t of trips || []) await sb.from('delivery_proofs').delete().eq('trip_id', t.id);
      await sb.from('trips').delete().eq('request_id', r.id);
      await sb.from('offers').delete().eq('request_id', r.id);
    }
    const { data: dtrips } = await sb.from('trips').select('id').eq('driver_id', id);
    for (const t of dtrips || []) await sb.from('delivery_proofs').delete().eq('trip_id', t.id);
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
async function signup(phone) {
  const s = await api('POST', '/signup/start', { phone });
  const v = await api('POST', '/signup/verify', { phone, code: s.json.dev_code });
  return { id: v.json.user_id, auth: { Authorization: 'Bearer ' + v.json.token } };
}
async function onlineCourier(phone) {
  const d = await signup(phone);
  await api('POST', '/driver/register', {}, d.auth);
  for (const k of ['national_id','drivers_licence','vehicle_registration','roadworthiness','insurance','police_clearance'])
    await api('POST', '/driver/documents', { kind: k, vault_key: 'v://'+k, status: 'passed' }, d.auth);
  await api('POST', '/driver/submit-for-review', {}, d.auth);
  await api('POST', `/driver/${d.id}/approve`, {}, { 'x-admin-key': ADMIN_KEY });
  await api('POST', '/driver/face-check', { selfie_vault_key: 'v://s', match_score: 0.95 }, d.auth);
  await api('POST', '/driver/go-online', A, d.auth);
  return d;
}

(async () => {
  console.log('\n=== Courier end-to-end ===\n');
  if (!ADMIN_KEY) { console.log('  (!) ADMIN_KEY missing'); process.exit(1); }
  await cleanup(SENDER); await cleanup(COURIER);

  const sender = await signup(SENDER);
  const courier = await onlineCourier(COURIER);
  check('sender + online courier set up', !!sender.id && !!courier.id);

  // 1. sender requests a delivery
  const reqRes = await api('POST', '/deliveries/request', {
    pickup: A, dropoff: B, proposed_fare: 3.50,
    parcel_size: 'small', parcel_desc: 'documents',
    recipient_name: 'Tendai', recipient_phone: '0779999888',
    pickup_label: 'CBD', dropoff_label: 'Avondale',
  }, sender.auth);
  check('delivery request created', reqRes.json.status === 'open' && reqRes.json.request.request_kind === 'delivery', reqRes.json);
  const reqId = reqRes.json.request && reqRes.json.request.id;

  // 2. courier sees it nearby + offers
  await api('GET', `/rides/nearby?lng=${A.lng}&lat=${A.lat}`, null, courier.auth);
  const offerRes = await api('POST', `/rides/${reqId}/offer`, { offered_fare: 4.00, eta_minutes: 6 }, courier.auth);
  check('courier makes offer', offerRes.json.status === 'offer_sent', offerRes.json);
  const offerId = offerRes.json.offer && offerRes.json.offer.id;

  // 3. sender accepts -> handover code generated
  const accept = await api('POST', `/rides/${reqId}/accept`, { offer_id: offerId }, sender.auth);
  check('accepted -> matched, delivery trip', accept.json.status === 'matched' && accept.json.trip.request_kind === 'delivery', accept.json);
  check('handover code generated (dev)', !!accept.json.dev_handover_code, accept.json);
  const tripId = accept.json.trip.id;
  const handover = accept.json.dev_handover_code;

  // 4. courier: arrived -> in_progress
  await api('POST', `/trips/${tripId}/status`, { status: 'arrived' }, courier.auth);
  await api('POST', `/trips/${tripId}/status`, { status: 'in_progress' }, courier.auth);

  // 5. pickup proof
  const pp = await api('POST', `/trips/${tripId}/pickup-proof`, { photo_vault_key: 'v://pickup', note: 'collected' }, courier.auth);
  check('pickup proof recorded', pp.json.status === 'pickup_recorded', pp.json);

  // 6. wrong code rejected
  const bad = await api('POST', `/trips/${tripId}/deliver`, { code: '0000' }, courier.auth);
  check('wrong handover code rejected', bad.status === 400, bad.json);

  // 7. correct code delivers
  const deliver = await api('POST', `/trips/${tripId}/deliver`, { code: handover }, courier.auth);
  check('delivered with correct code', deliver.json.status === 'delivered' && deliver.json.method === 'code', deliver.json);

  // 8. trip is completed
  const trip = await api('GET', `/trips/${tripId}`, null, sender.auth);
  check('trip completed', trip.json.trip && trip.json.trip.status === 'completed', trip.json);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
