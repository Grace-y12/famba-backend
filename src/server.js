/**
 * server.js — the backend entry point (Supabase-client version).
 */
'use strict';

require('dotenv').config();
const express = require('express');
const db = require('./db/db');
const tokens = require('./modules/identity/tokens');
const createSignupRoutes = require('./modules/identity/signup-routes');
const createDriverRoutes = require('./modules/identity/driver-routes');
const createMarketplaceRoutes = require('./modules/marketplace/marketplace-routes');
const createCourierRoutes = require('./modules/courier/courier-routes');
const sms = require('./modules/sms/sms');

const cors = require('cors');
const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN }));
app.use(express.json());

// --- 1. Health check ---
app.get('/health', async (_req, res) => {
  try {
    const info = await db.healthCheck();
    res.json({ status: 'ok', database: 'connected', ...info });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'unreachable', error: err.message });
  }
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

// --- 3. Driver onboarding (register, documents, review, face-check, online) ---
app.use('/driver', createDriverRoutes(db.supabase, tokens.requireAuth));

// --- 4. Marketplace (ride requests, offers, trips) ---
app.use('/', createMarketplaceRoutes(db.supabase, tokens.requireAuth, sms));

// --- 5. Courier (parcel delivery) ---
app.use('/', createCourierRoutes(db.supabase, tokens.requireAuth, sms));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ridehail backend listening on http://localhost:${PORT}`);
  console.log(`  try:  curl http://localhost:${PORT}/health`);
});
