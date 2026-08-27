/**
 * rider-routes.js — the rider's own profile, KYC and ride history.
 *
 *   GET   /rider/profile   -> user + kyc tier + documents
 *   PATCH /rider/profile   -> set full_name, email, and (once) the national ID
 *   GET   /rider/rides     -> the rider's own trips
 *   POST  /rider/kyc       -> submit an ID document reference (tier 2)
 *
 * PRIVACY: the raw national ID number is NEVER written to the database. We
 * store a salted SHA-256 hash (so the same ID can be recognised across
 * accounts) plus the last four characters (so the rider can see which ID is
 * on file). Same principle as kyc_documents holding a vault_key rather than
 * the document itself — per the Zimbabwe Data Protection Act.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Zimbabwe national ID: registry office (2 digits), serial (6-7 digits),
 * check letter, district of origin (2 digits). People write it many ways —
 * 63-1234567X42, 63 1234567 X 42, 63-1234567-X-42 — so strip everything that
 * isn't alphanumeric first, then test the shape.
 *
 * TODO: confirm the serial length against real IDs before launch; a validator
 * that rejects legitimate documents is worse than a lenient one.
 */
function normaliseNid(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^\d{2}\d{6,7}[A-Z]\d{2}$/.test(s) ? s : null;
}

function hashNid(nid) {
  return crypto.createHash('sha256')
    .update(nid + (process.env.NID_SALT || ''))
    .digest('hex');
}

module.exports = function createRiderRoutes(supabase, requireAuth) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/profile', async (req, res) => {
    const { data: user, error } = await supabase.from('users')
      .select('id, phone, phone_verified, full_name, email, status')
      .eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'user_not_found' });

    const { data: prof } = await supabase.from('rider_profiles')
      .select('kyc_tier, national_id_last4, profile_completed_at')
      .eq('user_id', req.user.id).single();
    const { data: docs } = await supabase.from('kyc_documents')
      .select('kind, status').eq('user_id', req.user.id);

    res.json({
      ...user,
      kyc_tier: prof?.kyc_tier || 'tier1',
      national_id_last4: prof?.national_id_last4 || null,
      profile_completed_at: prof?.profile_completed_at || null,
      documents: docs || [],
    });
  });

  router.patch('/profile', async (req, res) => {
    const name = (req.body?.full_name || '').trim();
    const nidRaw = req.body?.national_id;

    if (name.length < 2) return res.status(400).json({ error: 'invalid_name' });

    // Email is optional. An explicit empty string clears it; omitting the key
    // entirely leaves whatever is already stored alone — so a later edit that
    // sends only a name can't silently wipe an address.
    const userPatch = { full_name: name };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'email')) {
      const email = (req.body.email || '').trim();
      if (email && !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      userPatch.email = email || null;
    }

    const { error: uErr } = await supabase.from('users')
      .update(userPatch).eq('id', req.user.id);
    if (uErr) {
      console.error('[rider/profile name]', uErr.message);
      return res.status(500).json({ error: 'could_not_update' });
    }

    const patch = { profile_completed_at: new Date().toISOString() };

    // The national ID number is optional — the signup flow currently sends a
    // document reference via POST /rider/kyc instead. This path stays for the
    // typed-number fallback and for later edits.
    if (nidRaw) {
      const nid = normaliseNid(nidRaw);
      if (!nid) return res.status(400).json({ error: 'invalid_national_id' });
      patch.national_id_hash = hashNid(nid);
      patch.national_id_last4 = nid.slice(-4);
    }

    const { error: pErr } = await supabase.from('rider_profiles')
      .update(patch).eq('user_id', req.user.id);
    if (pErr) {
      console.error('[rider/profile kyc]', pErr.message);
      return res.status(500).json({ error: 'could_not_update_profile' });
    }

    res.json({ status: 'updated', full_name: name, email: userPatch.email });
  });

  router.get('/rides', async (req, res) => {
    const { data, error } = await supabase.from('trips')
      .select('id, status, agreed_fare, request_kind, trip_requests(pickup_label, dropoff_label)')
      .eq('rider_id', req.user.id).order('id', { ascending: false }).limit(30);
    if (error) {
      console.error('[rider/rides]', error.message);
      return res.status(500).json({ error: 'could_not_load_rides' });
    }
    res.json({ rides: data || [] });
  });

  router.post('/kyc', async (req, res) => {
    const { kind, vault_key } = req.body || {};
    if (!['national_id', 'passport'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    if (!vault_key) return res.status(400).json({ error: 'vault_key_required' });

    const { error } = await supabase.from('kyc_documents')
      .insert({ user_id: req.user.id, kind, vault_key, status: 'pending' });
    if (error) {
      console.error('[rider/kyc]', error.message);
      return res.status(500).json({ error: 'could_not_submit' });
    }

    // DEMO SHORTCUT — remove with the other demo flags before launch.
    if (process.env.DEMO_AUTO_APPROVE === 'true') {
      await supabase.from('rider_profiles').update({ kyc_tier: 'tier2' }).eq('user_id', req.user.id);
      return res.json({ status: 'verified', kyc_tier: 'tier2' });
    }
    res.json({ status: 'pending_review' });
  });

  return router;
};