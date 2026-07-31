require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log('URL loaded:', process.env.SUPABASE_URL ? 'yes' : 'NO');
console.log('Key loaded:', process.env.SUPABASE_SECRET_KEY ? 'yes' : 'NO');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

supabase.from('users').select('id').limit(1)
  .then(({ error }) => {
    if (error) console.log('FAILED:', error.message);
    else console.log('CONNECTED OK — Supabase URL + key work');
  })
  .catch((e) => console.log('FAILED:', e.message));