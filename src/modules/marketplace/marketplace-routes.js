/**
 * marketplace-routes.js — the bid-based ride flow.
 *
 * Rider:
 *   POST /rides/request                 { pickup, dropoff, proposed_fare }
 *   GET  /rides/:id/offers              list offers on my request
 *   POST /rides/:id/accept              { offer_id }  -> locks fare, makes trip
 *   POST /rides/:id/cancel
 *
 * Driver:
 *   GET  /rides/nearby                  open requests near me (live drivers)
 *   POST /rides/:id/offer               { offered_fare, eta_minutes }
 *
 * Trip (either party as appropriate):
 *   POST /trips/:id/status              { status }   advance trip lifecycle
 *   GET  /trips/:id                     view a trip
 *
 * All routes require a valid token. The acting user is always req.user.id.
 */
'use strict';

const express = require('express');
const m = require('./marketplace');
const courier = require('../courier/courier');

module.exports = function createMarketplaceRoutes(supabase, requireAuth, sms) {
  const router = express.Router();
  router.use(requireAuth);

  // ---------------- RIDER: create a ride request ----------------
  router.post('/rides/request', async (req, res) => {
    const riderId = req.user.id;
    const { pickup, dropoff, proposed_fare, pickup_label, dropoff_label } = req.body || {};

    const fareCheck = m.validateFare(proposed_fare);
    if (!fareCheck.ok) return res.status(400).json({ error: fareCheck.reason });

    if (!pickup || !dropoff) return res.status(400).json({ error: 'pickup_and_dropoff_required' });
    const pc = m.validateLngLat(pickup.lng, pickup.lat);
    const dc = m.validateLngLat(dropoff.lng, dropoff.lat);
    if (!pc.ok) return res.status(400).json({ error: 'pickup_' + pc.reason });
    if (!dc.ok) return res.status(400).json({ error: 'dropoff_' + dc.reason });

    const { data, error } = await supabase
      .from('trip_requests')
      .insert({
        rider_id: riderId,
        pickup: `POINT(${pickup.lng} ${pickup.lat})`,
        pickup_label: pickup_label || null,
        dropoff: `POINT(${dropoff.lng} ${dropoff.lat})`,
        dropoff_label: dropoff_label || null,
        proposed_fare,
        expires_at: m.requestExpiry().toISOString(),
      })
      .select('id, status, proposed_fare, expires_at')
      .single();
    if (error) {
      console.error('[rides/request]', error.message);
      return res.status(500).json({ error: 'could_not_create_request' });
    }
    res.json({ status: 'open', request: data });
  });

  // ---------------- DRIVER: find nearby open requests ----------------
  // Uses a PostGIS distance query. Only drivers with a live session should
  // call this; we also refresh their last_seen_at heartbeat here.
  router.get('/rides/nearby', async (req, res) => {
    const driverId = req.user.id;
    const lng = parseFloat(req.query.lng);
    const lat = parseFloat(req.query.lat);
    const cc = m.validateLngLat(lng, lat);
    if (!cc.ok) return res.status(400).json({ error: cc.reason });

    // Heartbeat: mark this driver's session fresh + update location.
    await supabase
      .from('driver_sessions')
      .update({ last_seen_at: new Date().toISOString(), last_location: `POINT(${lng} ${lat})` })
      .eq('driver_id', driverId)
      .eq('is_online', true);

    // Find open, unexpired requests within radius, nearest first.
    // We use an RPC for the distance query (defined in the migration).
    const { data, error } = await supabase.rpc('nearby_open_requests', {
      p_lng: lng, p_lat: lat, p_radius_m: m.MATCH_RADIUS_M,
    });
    if (error) {
      console.error('[rides/nearby]', error.message);
      return res.status(500).json({ error: 'could_not_search' });
    }
    res.json({ requests: data || [] });
  });

  // ---------------- DRIVER: make an offer ----------------
  router.post('/rides/:id/offer', async (req, res) => {
    const driverId = req.user.id;
    const { offered_fare, eta_minutes } = req.body || {};

    const { data: request } = await supabase
      .from('trip_requests').select('status, proposed_fare, expires_at')
      .eq('id', req.params.id).single();

    const check = m.validateOffer(request, offered_fare);
    if (!check.ok) return res.status(400).json({ error: check.reason });
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(400).json({ error: 'request_expired' });
    }

    const { data, error } = await supabase
      .from('offers')
      .upsert({
        request_id: req.params.id,
        driver_id: driverId,
        offered_fare,
        eta_minutes: typeof eta_minutes === 'number' ? eta_minutes : null,
        status: 'pending',
      }, { onConflict: 'request_id,driver_id' })
      .select('id, offered_fare, eta_minutes, status')
      .single();
    if (error) {
      console.error('[rides/offer]', error.message);
      return res.status(500).json({ error: 'could_not_offer' });
    }
    res.json({ status: 'offer_sent', offer: data });
  });

  // ---------------- RIDER: see offers on my request ----------------
  router.get('/rides/:id/offers', async (req, res) => {
    const { data: request } = await supabase
      .from('trip_requests').select('rider_id').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'request_not_found' });
    if (request.rider_id !== req.user.id) return res.status(403).json({ error: 'not_your_request' });

    const { data, error } = await supabase
      .from('offers')
      .select('id, driver_id, offered_fare, eta_minutes, status, created_at')
      .eq('request_id', req.params.id)
      .eq('status', 'pending')
      .order('offered_fare', { ascending: true });
    if (error) return res.status(500).json({ error: 'could_not_list_offers' });
    res.json({ offers: data || [] });
  });

  // ---------------- RIDER: accept an offer -> LOCK FARE, make trip ----------------
  router.post('/rides/:id/accept', async (req, res) => {
    const riderId = req.user.id;
    const { offer_id } = req.body || {};
    if (!offer_id) return res.status(400).json({ error: 'offer_id_required' });

    const { data: request } = await supabase
      .from('trip_requests')
      .select('id, rider_id, status, request_kind, recipient_name, recipient_phone')
      .eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'request_not_found' });
    if (request.rider_id !== riderId) return res.status(403).json({ error: 'not_your_request' });
    if (request.status !== 'open') return res.status(400).json({ error: 'request_not_open' });

    const { data: offer } = await supabase
      .from('offers').select('id, driver_id, offered_fare, status, request_id')
      .eq('id', offer_id).single();
    if (!offer || offer.request_id !== request.id) return res.status(404).json({ error: 'offer_not_found' });
    if (offer.status !== 'pending') return res.status(400).json({ error: 'offer_not_available' });

    // For deliveries, generate a handover code the recipient will give the
    // courier to confirm receipt. Stored hashed on the trip.
    const isDelivery = request.request_kind === 'delivery';
    let handoverCode = null;
    const tripInsert = {
      request_id: request.id,
      offer_id: offer.id,
      rider_id: riderId,
      driver_id: offer.driver_id,
      agreed_fare: offer.offered_fare,  // <-- the locked fare
      status: 'driver_assigned',
      request_kind: request.request_kind,
    };
    if (isDelivery) {
      handoverCode = courier.generateHandoverCode();
      tripInsert.delivery_code_hash = courier.hashCode(handoverCode);
    }

    // Create the trip with the LOCKED fare from the accepted offer.
    const { data: trip, error: tripErr } = await supabase
      .from('trips')
      .insert(tripInsert)
      .select('id, status, agreed_fare, driver_id, request_kind')
      .single();
    if (tripErr) {
      console.error('[rides/accept]', tripErr.message);
      return res.status(500).json({ error: 'could_not_create_trip' });
    }

    // Close the request and the offers.
    await supabase.from('trip_requests').update({ status: 'matched' }).eq('id', request.id);
    await supabase.from('offers').update({ status: 'accepted' }).eq('id', offer.id);
    await supabase.from('offers').update({ status: 'rejected' })
      .eq('request_id', request.id).neq('id', offer.id);

    // Notify the recipient of a delivery with the handover code + tracking.
    if (isDelivery && sms && request.recipient_phone) {
      const msg = `RideHail: a parcel is on its way to you. Give the courier this code to confirm delivery: ${handoverCode}. Track: ridehail.app/t/${trip.id}`;
      // Fire-and-forget; a failed SMS shouldn't block the match.
      sms.sendSms(request.recipient_phone, msg).catch((e) =>
        console.error('[rides/accept] recipient sms failed:', e.message));
    }

    // In dev mode, surface the handover code so the flow is testable.
    const resp = { status: 'matched', trip };
    if (isDelivery && sms && sms.MODE === 'dev') resp.dev_handover_code = handoverCode;
    res.json(resp);
  });

  // ---------------- RIDER: cancel an open request ----------------
  router.post('/rides/:id/cancel', async (req, res) => {
    const { data: request } = await supabase
      .from('trip_requests').select('rider_id, status').eq('id', req.params.id).single();
    if (!request) return res.status(404).json({ error: 'request_not_found' });
    if (request.rider_id !== req.user.id) return res.status(403).json({ error: 'not_your_request' });
    if (request.status !== 'open') return res.status(400).json({ error: 'cannot_cancel' });
    await supabase.from('trip_requests').update({ status: 'cancelled' }).eq('id', req.params.id);
    res.json({ status: 'cancelled' });
  });

  // ---------------- TRIP: advance lifecycle ----------------
  router.post('/trips/:id/status', async (req, res) => {
    const userId = req.user.id;
    const { status: next } = req.body || {};

    const { data: trip } = await supabase
      .from('trips').select('id, rider_id, driver_id, status').eq('id', req.params.id).single();
    if (!trip) return res.status(404).json({ error: 'trip_not_found' });
    // Only the rider or driver on this trip may change it.
    if (trip.rider_id !== userId && trip.driver_id !== userId) {
      return res.status(403).json({ error: 'not_your_trip' });
    }

    let validated;
    try { validated = m.tripTransition(trip.status, next); }
    catch (e) { return res.status(400).json({ error: 'illegal_transition', from: trip.status, to: next }); }

    const stamps = {
      arrived: { arrived_at: new Date().toISOString() },
      in_progress: { started_at: new Date().toISOString() },
      completed: { completed_at: new Date().toISOString() },
      cancelled: { cancelled_at: new Date().toISOString() },
    }[validated] || {};

    const { error } = await supabase
      .from('trips').update({ status: validated, ...stamps }).eq('id', trip.id);
    if (error) return res.status(500).json({ error: 'could_not_update_trip' });
    res.json({ status: validated, trip_id: trip.id });
  });

  // ---------------- TRIP: view ----------------
  router.get('/trips/:id', async (req, res) => {
    const { data: trip } = await supabase
      .from('trips')
      .select('id, status, agreed_fare, currency, rider_id, driver_id, assigned_at, completed_at')
      .eq('id', req.params.id).single();
    if (!trip) return res.status(404).json({ error: 'trip_not_found' });
    if (trip.rider_id !== req.user.id && trip.driver_id !== req.user.id) {
      return res.status(403).json({ error: 'not_your_trip' });
    }
    res.json({ trip });
  });

  return router;
};
