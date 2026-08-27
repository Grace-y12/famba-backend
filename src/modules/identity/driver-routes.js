/**
 * driver-routes.js — driver onboarding endpoints.
 *
 * Flow (mirrors the tested state machine in driver-kyc.js):
 *   POST /driver/register            -> creates driver_profiles row (registered)
 *   POST /driver/documents           -> submit a KYC document (vault ref only)
 *   GET  /driver/readiness           -> are all required docs present & valid?
 *   POST /driver/submit-for-review   -> registered/pending -> under_review
 *   POST /driver/face-check          -> per-shift selfie face match
 *   POST /driver/go-online           -> opens a session IF approved + face ok
 *
 * Admin-only (separate, simple guard for now):
 *   POST /driver/:id/approve         -> under_review -> approved
 *   POST /driver/:id/reject          -> -> rejected
 *
 * All driver endpoints require a valid token (requireAuth). The acting
 * driver is ALWAYS req.user.id — a driver can only act on their own record,
 * never another's. Admin endpoints additionally require an admin key.
 *
 * IMPORTANT (privacy): we never store raw ID images here. The mobile app
 * uploads the image to the identity provider / object store and sends us
 * only a vault_key reference plus the provider's result. The main tables
 * hold references, not documents — per the schema design and the Zimbabwe
 * Data Protection Act.
 */
'use strict';

const express = require('express');
const kyc = require('./driver-kyc');

// Documents a driver may submit, matching the document_kind enum in SQL.
const VALID_DOC_KINDS = new Set([
  'national_id', 'passport', 'drivers_licence',
  'vehicle_registration', 'roadworthiness', 'insurance', 'police_clearance',
]);

module.exports = function createDriverRoutes(supabase, requireAuth) {
  const router = express.Router();

  // ---------- admin endpoints (guarded by admin key, NOT a driver token) ----------
  // These MUST be registered before router.use(requireAuth) below, otherwise
  // the driver-token check would reject an admin who has no driver token.
  // Simple shared-key guard — fine for a pilot; replace with real admin
  // accounts before launch.
  function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'admin_only' });
    }
    next();
  }

  router.post('/:id/approve', requireAdmin, async (req, res) => {
    const moved = await transitionDriver(supabase, req.params.id, 'approved', {
      approved_at: new Date().toISOString(),
    });
    if (!moved.ok) return res.status(400).json({ error: moved.reason });
    res.json({ status: 'approved', driver_id: req.params.id });
  });

  router.post('/:id/reject', requireAdmin, async (req, res) => {
    const reason = (req.body && req.body.reason) || 'unspecified';
    const moved = await transitionDriver(supabase, req.params.id, 'rejected', {
      rejection_reason: reason,
    });
    if (!moved.ok) return res.status(400).json({ error: moved.reason });
    res.json({ status: 'rejected', driver_id: req.params.id });
  });

  // Every route BELOW here requires a logged-in user (driver acting on self).
  router.use(requireAuth);

  // --- Register as a driver (idempotent) ---
  router.post('/register', async (req, res) => {
    const userId = req.user.id;
    // Already a driver?
    const { data: existing } = await supabase
      .from('driver_profiles').select('user_id, status').eq('user_id', userId).limit(1);
    if (existing && existing[0]) {
      return res.json({ status: existing[0].status, already_registered: true });
    }
    const { error } = await supabase
      .from('driver_profiles').insert({ user_id: userId, status: 'registered' });
    if (error) {
      console.error('[driver/register]', error.message);
      return res.status(500).json({ error: 'could_not_register' });
    }
    res.json({ status: 'registered' });
  });

  // --- Submit a KYC document (reference only) ---
  router.post('/documents', async (req, res) => {
    const userId = req.user.id;
    const { kind, vault_key, provider, provider_ref, expires_on, status } = req.body || {};

    if (!VALID_DOC_KINDS.has(kind)) {
      return res.status(400).json({ error: 'invalid_document_kind' });
    }
    if (!vault_key || typeof vault_key !== 'string') {
      return res.status(400).json({ error: 'vault_key_required' });
    }

    // status defaults to 'pending'; a real provider callback would set
    // 'passed'/'failed'. We accept a status here to support the dev flow,
    // but only allow the known verification states.
    const allowedStatus = new Set(['pending', 'passed', 'failed', 'manual_review']);
    const docStatus = allowedStatus.has(status) ? status : 'pending';

    const { data, error } = await supabase
      .from('kyc_documents')
      .insert({
        user_id: userId,
        kind,
        status: docStatus,
        vault_key,
        provider: provider || null,
        provider_ref: provider_ref || null,
        expires_on: expires_on || null,
      })
      .select('id, kind, status')
      .single();
    if (error) {
      console.error('[driver/documents]', error.message);
      return res.status(500).json({ error: 'could_not_save_document' });
    }

    // Move driver from 'registered' to 'documents_pending' on first doc.
    await maybeAdvance(supabase, userId, 'documents_pending');
    res.json({ status: 'document_saved', document: data });
  });

  // --- Readiness: does the driver meet every requirement? ---
    router.get('/readiness', async (req, res) => {
    const { data: docs, error } = await supabase
      .from('kyc_documents')
      .select('kind, status, expires_on')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'could_not_evaluate' });

    const { data: profile } = await supabase
      .from('driver_profiles')
      .select('status')
      .eq('user_id', req.user.id)
      .single();

    res.json({
      ...kyc.evaluateApprovalReadiness(docs || []),
      status: profile?.status || 'registered',
    });
  });

  // --- Submit for review (driver asks to be reviewed) ---
  router.post('/submit-for-review', async (req, res) => {
    const userId = req.user.id;
    const { data: docs } = await supabase
      .from('kyc_documents').select('kind, status, expires_on').eq('user_id', userId);
    const readiness = kyc.evaluateApprovalReadiness(docs || []);
    if (!readiness.ready) {
      return res.status(400).json({ error: 'not_ready', missing: readiness.missing });
    }
        const moved = await transitionDriver(supabase, userId, 'under_review');
    if (!moved.ok) return res.status(400).json({ error: moved.reason });

    // DEMO ONLY — approves a few seconds after submission so the flow can be
    // walked end to end without an agent. Remove before launch.
    if (process.env.DEMO_AUTO_APPROVE === 'true') {
      setTimeout(async () => {
        try {
          await transitionDriver(supabase, userId, 'approved', {
            approved_at: new Date().toISOString(),
          });
          console.log('[demo-auto-approve] approved', userId);
        } catch (e) { console.error('[demo-auto-approve]', e.message); }
      }, 4000);
    }

    res.json({ status: 'under_review' });
  });

  // --- Per-shift face check ---
  router.post('/face-check', async (req, res) => {
    const userId = req.user.id;
    const { selfie_vault_key, match_score, provider_ref } = req.body || {};
    if (!selfie_vault_key) return res.status(400).json({ error: 'selfie_vault_key_required' });

    const outcome = kyc.evaluateFaceCheck(typeof match_score === 'number' ? match_score : NaN);

    const { data, error } = await supabase
      .from('shift_face_checks')
      .insert({
        driver_id: userId,
        status: outcome.status,
        match_score: typeof match_score === 'number' ? match_score : null,
        selfie_vault_key,
        provider_ref: provider_ref || null,
      })
      .select('id, status, checked_at')
      .single();
    if (error) {
      console.error('[driver/face-check]', error.message);
      return res.status(500).json({ error: 'could_not_record_check' });
    }
    res.json({ face_check: data, reason: outcome.reason });
  });

  // --- Go online: only if approved AND a fresh passed face check exists ---
  router.post('/go-online', async (req, res) => {
    const userId = req.user.id;
    const { lng, lat } = req.body || {};

    const { data: prof } = await supabase
      .from('driver_profiles').select('status').eq('user_id', userId).single();
    if (!prof) return res.status(404).json({ error: 'not_a_driver' });

    const { data: checks } = await supabase
      .from('shift_face_checks')
      .select('status, checked_at')
      .eq('driver_id', userId)
      .order('checked_at', { ascending: false })
      .limit(1);

    const decision = kyc.canGoOnline(prof, checks && checks[0]);
    if (!decision.allowed) {
      return res.status(403).json({ error: 'cannot_go_online', reason: decision.reason });
    }

    // Open a session. Location optional at this point.
    const location = (typeof lng === 'number' && typeof lat === 'number')
      ? `POINT(${lng} ${lat})` : null;
    const { data: lastCheck } = await supabase
      .from('shift_face_checks').select('id').eq('driver_id', userId)
      .order('checked_at', { ascending: false }).limit(1).single();

    const { data: session, error } = await supabase
      .from('driver_sessions')
      .insert({
        driver_id: userId,
        opened_by_check: lastCheck.id,
        is_online: true,
        last_location: location,
      })
      .select('id, is_online, opened_at')
      .single();
    if (error) {
      console.error('[driver/go-online]', error.message);
      return res.status(500).json({ error: 'could_not_open_session' });
    }
    res.json({ status: 'online', session });
  });

  return router;
};

// ---------- helpers ----------

// Move a driver to a new status, enforcing the state machine. Returns
// { ok, reason }. Reads current status, validates the transition, writes.
async function transitionDriver(supabase, userId, next, extraFields = {}) {
  const { data: prof, error } = await supabase
    .from('driver_profiles').select('status').eq('user_id', userId).single();
  if (error || !prof) return { ok: false, reason: 'driver_not_found' };

  try {
    kyc.transition(prof.status, next); // throws if illegal
  } catch (e) {
    return { ok: false, reason: 'illegal_transition' };
  }

  const { error: upErr } = await supabase
    .from('driver_profiles')
    .update({ status: next, ...extraFields })
    .eq('user_id', userId);
  if (upErr) return { ok: false, reason: 'update_failed' };
  return { ok: true, reason: null };
}

// Best-effort advance only if the transition is legal from current state.
// Used when a driver submits their first document.
async function maybeAdvance(supabase, userId, next) {
  const { data: prof } = await supabase
    .from('driver_profiles').select('status').eq('user_id', userId).single();
  if (!prof) return;
  try {
    kyc.transition(prof.status, next);
    await supabase.from('driver_profiles').update({ status: next }).eq('user_id', userId);
  } catch (_) {
    // already past this state — fine, do nothing
  }
}
