/**
 * server.js — the backend entry point (Supabase-client version).
 *
 * MIDDLEWARE ORDER MATTERS. Express runs app.use() in registration order:
 *   1. cors            — must come first, or routes registered above it
 *                        answer without Access-Control-Allow-Origin and the
 *                        browser blocks them (PowerShell/curl won't notice).
 *   2. express.json    — body parsing, before anything that reads req.body.
 *   3. specific routes — /signup, /driver, /rider …
 *   4. catch-all routers mounted at '/' — these run requireAuth on EVERY
 *                        path beneath them, so anything below them that
 *                        isn't already matched gets a 401.
 */
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db/db');
const tokens = require('./modules/identity/tokens');
const createSignupRoutes = require('./modules/identity/signup-routes');
const createRiderRoutes = require('./modules/identity/rider-routes');
const createDriverRoutes = require('./modules/identity/driver-routes');
const createMarketplaceRoutes = require('./modules/marketplace/marketplace-routes');
const createCourierRoutes = require('./modules/courier/courier-routes');
const sms = require('./modules/sms/sms');

const app = express();

// --- 0. CORS (first) ---
// WEB_ORIGIN accepts a comma-separated list, e.g.
//   WEB_ORIGIN=http://localhost:5173,https://famba-frontend.vercel.app
// Trailing slashes are tolerated; Vercel preview URLs for this project are
// allowed by pattern so every push doesn't need a new env var.
const allowed = (process.env.WEB_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl, server-to-server
    const clean = origin.replace(/\/$/, '');
    if (allowed.includes(clean)) return cb(null, true);
    if (/^https:\/\/famba-frontend-[a-z0-9-]+\.vercel\.app$/.test(clean)) return cb(null, true);
    cb(new Error('blocked_by_cors'));
  },
}));

app.use(express.json());

// --- 1. Health check ---
// Always answers 200 so a Render health check can't roll back a deploy over a
// transient database blip; the database state is reported in the body.
app.get('/health', async (_req, res) => {
  try {
    const info = await db.healthCheck();
    res.json({ status: 'ok', database: 'connected', ...info });
  } catch (err) {
    res.json({ status: 'degraded', database: 'unreachable', error: err.message });
  }
});

// --- 1b. Root — so visiting the base URL isn't confusing ---
app.get('/', (_req, res) => {
  res.json({ service: 'ridehail-backend', status: 'up' });
});

// --- 2. Rider signup (phone + OTP) ---
app.use('/signup', createSignupRoutes(db.supabase));

// --- 2b. Who am I? Protected: requires a valid token. ---
app.get('/me', tokens.requireAuth, async (req, res) => {
  const { data, error } = await db.supabase
    .from('users')
    .select('id, phone, phone_verified, full_name, status')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'user_not_found' });
  res.json({ ...data, role: req.user.role });
});

// --- 2c. Rider profile, KYC and ride history ---
app.use('/rider', createRiderRoutes(db.supabase, tokens.requireAuth));

// --- 3. Driver onboarding (register, documents, review, face-check, online) ---
app.use('/driver', createDriverRoutes(db.supabase, tokens.requireAuth));

// --- 4. Marketplace (ride requests, offers, trips) ---
// Mounted at '/', so it must stay BELOW every specific route above.
app.use('/', createMarketplaceRoutes(db.supabase, tokens.requireAuth, sms));

// --- 5. Courier (parcel delivery) ---
app.use('/', createCourierRoutes(db.supabase, tokens.requireAuth, sms));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ridehail backend listening on http://localhost:${PORT}`);
  console.log(`  try:  curl http://localhost:${PORT}/health`);
});