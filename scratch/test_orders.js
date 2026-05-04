
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      crop_listings:listing_id (variety, unit, location),
      farmer:users!farmer_id (full_name, phone),
      bid:bids!bid_id (quantity)
    `)
    .eq('trader_id', '9810b81c-be26-40ac-8aa7-867296aebd96');
    
  if (error) {
    console.error('ERROR:', error);
  } else {
    console.log('DATA:', JSON.stringify(data, null, 2));
  }
}

test();
