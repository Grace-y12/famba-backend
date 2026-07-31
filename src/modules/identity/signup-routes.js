/**
 * signup-routes.js — rider signup endpoints.
 *
 *   POST /signup/start   { phone }          -> creates/refreshes a code
 *   POST /signup/verify  { phone, code }    -> verifies, creates the user
 *
 * NOTE ON SMS: in production the code is sent by SMS (e.g. Africa's Talking).
 * For now, when not in production, we RETURN the code in the response so you
 * can test the whole flow without paying for SMS. That dev-only behaviour is
 * clearly gated on NODE_ENV so it can never leak codes in production.
 */
'use strict';

const express = require('express');
const auth = require('./phone-auth');
const tokens = require('./tokens');

module.exports = function createSignupRoutes(supabase) {
  const router = express.Router();

  // --- Step 1: start signup ---
  router.post('/start', async (req, res) => {
    const phone = auth.normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });

    const code = auth.generateCode();
    const { error } = await supabase.from('phone_verifications').insert({
      phone,
      code_hash: auth.hashCode(code),
      expires_at: auth.expiryFrom().toISOString(),
    });
    if (error) {
      console.error('[signup/start]', error.message);
      return res.status(500).json({ error: 'could_not_start' });
    }

    const body = { status: 'code_sent', phone };
    // DEV ONLY: surface the code so you can test without SMS.
    if (process.env.NODE_ENV !== 'production') body.dev_code = code;
    res.json(body);
  });

  // --- Step 2: verify code & create the user ---
  router.post('/verify', async (req, res) => {
    const phone = auth.normalizePhone(req.body && req.body.phone);
    const code = req.body && req.body.code;
    if (!phone || !code) return res.status(400).json({ error: 'phone_and_code_required' });

    // Get the most recent code for this phone.
    const { data: rows, error: readErr } = await supabase
      .from('phone_verifications')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1);
    if (readErr) {
      console.error('[signup/verify read]', readErr.message);
      return res.status(500).json({ error: 'could_not_verify' });
    }

    const record = rows && rows[0];
    const result = auth.verifyCode(record, code);

    if (!result.ok) {
      // Count the failed attempt (best-effort) so codes can't be brute-forced.
      if (record && result.reason === 'code_incorrect') {
        await supabase
          .from('phone_verifications')
          .update({ attempts: record.attempts + 1 })
          .eq('id', record.id);
      }
      return res.status(400).json({ error: result.reason });
    }

    // Mark the code consumed so it can't be reused.
    await supabase
      .from('phone_verifications')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', record.id);

    // Create the user if they don't already exist; otherwise return existing.
    const { data: existing } = await supabase
      .from('users').select('id, phone').eq('phone', phone).limit(1);

    let user = existing && existing[0];
    if (!user) {
      const { data: created, error: insErr } = await supabase
        .from('users')
        .insert({ phone, phone_verified: true })
        .select('id, phone')
        .single();
      if (insErr) {
        console.error('[signup/verify insert]', insErr.message);
        return res.status(500).json({ error: 'could_not_create_user' });
      }
      user = created;

      // Every signed-up user gets a rider profile at tier1 (can book rides).
      await supabase.from('rider_profiles').insert({ user_id: user.id, kyc_tier: 'tier1' });
    } else {
      // Returning user — ensure phone marked verified.
      await supabase.from('users').update({ phone_verified: true }).eq('id', user.id);
    }

    res.json({
      status: 'verified',
      user_id: user.id,
      phone: user.phone,
      token: tokens.issueToken(user.id, 'rider'),
    });
  });

  return router;
};
