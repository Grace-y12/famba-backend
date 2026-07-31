/**
 * db.js — database access via the Supabase client library.
 *
 * This version connects using a Supabase URL + a SECRET API KEY instead of a
 * Postgres connection-string password. Same database, different door — and
 * this door doesn't involve assembling a password into a URL, which is what
 * kept failing.
 *
 * Both values come from environment variables and are NEVER hardcoded.
 * The secret key can read/write every row (it bypasses row-level security),
 * so it must ONLY ever live on the server, never in the mobile app, never
 * in git. The .gitignore already protects .env.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error(
    '\n[FATAL] SUPABASE_URL or SUPABASE_SECRET_KEY is not set.\n' +
    'Open .env and fill in both values from your Supabase dashboard\n' +
    '(Settings -> API Keys).\n'
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Connectivity check used by /health. We do a tiny read against a table we
 * know exists (users). If the key and URL are right, this returns without
 * error even when the table is empty.
 */
async function healthCheck() {
  const { error } = await supabase.from('users').select('id').limit(1);
  if (error) throw new Error(error.message);
  return { db_time: new Date().toISOString(), via: 'supabase-js' };
}

module.exports = { supabase, healthCheck };