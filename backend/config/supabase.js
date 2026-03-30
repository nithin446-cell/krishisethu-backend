const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client with Service Role (elevated privileges)
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from environment.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Storage Buckets (Environment driven)
const BUCKETS = {
  CROP_PICTURES: process.env.S3_BUCKET_CROP_PICTURES || 'crop_pictures',
  USER_DOCUMENTS: process.env.S3_BUCKET_USER_DOCUMENTS || 'user_documents',
  ORDER_PHOTOS: process.env.S3_BUCKET_ORDER_PHOTOS || 'order-photos',
  KYC_DOCUMENTS: process.env.S3_BUCKET_KYC_DOCUMENTS || 'kyc-documents',
};

module.exports = { supabase, BUCKETS };
