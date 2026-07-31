/**
 * courier-routes.js — parcel delivery endpoints.
 *
 * Reuses the marketplace for offers/accept/lifecycle. Adds:
 *   POST /deliveries/request            create a delivery request (parcel + recipient)
 *   POST /trips/:id/pickup-proof        courier records pickup (photo/note)
 *   POST /trips/:id/deliver             courier marks delivered (code or photo)
 *
 * When a delivery trip is created (via the normal /rides/:id/accept flow),
 * a handover code is generated and SMS'd to the recipient. The courier must
 * enter that code (or upload a delivery photo) to complete the delivery.
 *
 * NOTE: accepting a delivery offer uses the SAME /rides/:id/accept endpoint
 * as rides. That endpoint is extended (in marketplace-routes) to generate the
 * handover code + notify the recipient when request_kind = 'delivery'.
 */
'use strict';

const express = require('express');
const courier = require('./courier');
const auth = require('../identity/phone-auth');
const marketplace = require('../marketplace/marketplace');

module.exports = function createCourierRoutes(supabase, requireAuth, sms) {
  const router = express.Router();
  router.use(requireAuth);

  // ---- create a delivery request ----
  router.post('/deliveries/request', async (req, res) => {
    const senderId = req.user.id;
    const b = req.body || {};

    const fareCheck = marketplace.validateFare(b.proposed_fare);
    if (!fareCheck.ok) return res.status(400).json({ error: fareCheck.reason });
    if (!b.pickup || !b.dropoff) return res.status(400).json({ error: 'pickup_and_dropoff_required' });
    const pc = marketplace.validateLngLat(b.pickup.lng, b.pickup.lat);
    const dc = marketplace.validateLngLat(b.dropoff.lng, b.dropoff.lat);
    if (!pc.ok) return res.status(400).json({ error: 'pickup_' + pc.reason });
    if (!dc.ok) return res.status(400).json({ error: 'dropoff_' + dc.reason });

    const recipientPhone = auth.normalizePhone(b.recipient_phone);
    const details = {
      parcel_size: b.parcel_size,
      parcel_desc: b.parcel_desc,
      recipient_name: b.recipient_name,
      recipient_phone: recipientPhone,
    };
    const dCheck = courier.validateDeliveryDetails(details);
    if (!dCheck.ok) return res.status(400).json({ error: dCheck.reason });

    const { data, error } = await supabase
      .from('trip_requests')
      .insert({
        rider_id: senderId,
        request_kind: 'delivery',
        pickup: `POINT(${b.pickup.lng} ${b.pickup.lat})`,
        pickup_label: b.pickup_label || null,
        dropoff: `POINT(${b.dropoff.lng} ${b.dropoff.lat})`,
        dropoff_label: b.dropoff_label || null,
        proposed_fare: b.proposed_fare,
        parcel_size: details.parcel_size,
        parcel_desc: details.parcel_desc,
        parcel_photo_vault_key: b.parcel_photo_vault_key || null,
        recipient_name: details.recipient_name,
        recipient_phone: details.recipient_phone,
        expires_at: marketplace.requestExpiry().toISOString(),
      })
      .select('id, status, proposed_fare, request_kind')
      .single();
    if (error) {
      console.error('[deliveries/request]', error.message);
      return res.status(500).json({ error: 'could_not_create_request' });
    }
    res.json({ status: 'open', request: data });
  });

  // ---- courier records proof of pickup ----
  router.post('/trips/:id/pickup-proof', async (req, res) => {
    const userId = req.user.id;
    const { photo_vault_key, note } = req.body || {};

    const { data: trip } = await supabase
      .from('trips').select('id, driver_id, status, request_kind').eq('id', req.params.id).single();
    if (!trip) return res.status(404).json({ error: 'trip_not_found' });
    if (trip.driver_id !== userId) return res.status(403).json({ error: 'not_your_trip' });
    if (trip.request_kind !== 'delivery') return res.status(400).json({ error: 'not_a_delivery' });

    const { error } = await supabase.from('delivery_proofs').upsert({
      trip_id: trip.id, kind: 'pickup',
      photo_vault_key: photo_vault_key || null, note: note || null,
    }, { onConflict: 'trip_id,kind' });
    if (error) {
      console.error('[pickup-proof]', error.message);
      return res.status(500).json({ error: 'could_not_save_proof' });
    }
    res.json({ status: 'pickup_recorded' });
  });

  // ---- courier marks delivered (handover code OR delivery photo) ----
  router.post('/trips/:id/deliver', async (req, res) => {
    const userId = req.user.id;
    const { code, photo_vault_key, note } = req.body || {};

    const { data: trip } = await supabase
      .from('trips')
      .select('id, driver_id, status, request_kind, delivery_code_hash')
      .eq('id', req.params.id).single();
    if (!trip) return res.status(404).json({ error: 'trip_not_found' });
    if (trip.driver_id !== userId) return res.status(403).json({ error: 'not_your_trip' });
    if (trip.request_kind !== 'delivery') return res.status(400).json({ error: 'not_a_delivery' });

    const decision = courier.canMarkDelivered(trip, {
      code,
      hasDeliveryPhoto: !!photo_vault_key,
    });
    if (!decision.ok) return res.status(400).json({ error: decision.reason });

    // Record the delivery proof.
    await supabase.from('delivery_proofs').upsert({
      trip_id: trip.id, kind: 'delivery',
      photo_vault_key: photo_vault_key || null, note: note || null,
      confirmed_by_code: decision.method === 'code',
    }, { onConflict: 'trip_id,kind' });

    // Complete the trip.
    await supabase.from('trips').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      delivery_confirmed_at: new Date().toISOString(),
    }).eq('id', trip.id);

    res.json({ status: 'delivered', method: decision.method });
  });

  return router;
};
