const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client with Service Role (elevated privileges)
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from environment.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = { supabase };
