const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { supabase: adminSupabase, BUCKETS } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

// Multer and S3 setup for Farmer uploads
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const upload = multer({ dest: UPLOADS_DIR });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const s3Client = new S3Client({
  forcePathStyle: true,
  region: 'ap-south-1',
  endpoint: `${process.env.SUPABASE_URL}/storage/v1/s3`,
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim(),
  }
});

/**
 * POST /api/farmer/upload
 * Farmer uploads produce details and up to 5 images.
 */
router.post('/upload', authenticateToken, upload.array('images', 5), async (req, res) => {
  try {
    const { crop_name, variety, quantity, unit, base_price, location, description, status } = req.body;
    const farmer_id = req.user.id;

    // 1. Create crop listing record
    const { data: listingData, error: listingError } = await req.userSupabase
      .from('crop_listings')
      .insert([{
        farmer_id,
        variety: variety || crop_name,
        quantity: parseFloat(quantity),
        unit,
        current_price: parseFloat(base_price),
        location,
        description,
        status: status || 'active'
      }])
      .select().single();
      
    if (listingError) throw listingError;

    // 2. Upload images to S3 (Supabase Storage)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileName = `${listingData.id}-${Date.now()}${path.extname(file.originalname)}`;
        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: BUCKETS.CROP_PICTURES,
            Key: `${farmer_id}/${fileName}`,
            Body: fs.readFileSync(file.path),
            ContentType: file.mimetype
          }));
          
          const { data: publicUrlData } = adminSupabase.storage.from(BUCKETS.CROP_PICTURES).getPublicUrl(`${farmer_id}/${fileName}`);
          
          await req.userSupabase.from('crop_pictures').insert([{
            listing_id: listingData.id,
            image_url: publicUrlData.publicUrl
          }]);
        } finally {
          // Always ensure the local file is unlinked, even if S3 upload fails
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
      }
    }
    res.status(201).json({ message: 'Produce listed successfully.', data: listingData });
  } catch (error) {
    console.error('[FARMER_UPLOAD_ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/farmer/listings
 * Get all listings posted by the current farmer.
 */
router.get('/listings', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('crop_listings')
      .select(`*, bids ( id, trader_id, amount, quantity, status, created_at, users (full_name) )`)
      .eq('farmer_id', req.user.id)
      .in('status', ['active', 'sold'])
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/farmer/orders
 * Get tracking data for all orders accepted by the farmer.
 */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('orders')
      .select(`*, crop_listings (variety, unit), trader:users!trader_id (business_name, full_name, phone, location)`)
      .eq('farmer_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/farmer/kyc
 * Submit manual KYC documents for verification.
 */
router.post('/kyc', authenticateToken, upload.array('documents', 5), async (req, res) => {
  try {
    const { document_type } = req.body;
    const userId = req.user.id;
    if (!req.files || req.files.length === 0) throw new Error('No document images uploaded');

    const uploadedUrls = [];
    for (const file of req.files) {
      const fileName = `kyc-${userId}-${Date.now()}${path.extname(file.originalname)}`;
      await s3Client.send(new PutObjectCommand({ Bucket: BUCKETS.USER_DOCUMENTS, Key: fileName, Body: fs.readFileSync(file.path), ContentType: file.mimetype }));
      const { data: publicUrlData } = adminSupabase.storage.from(BUCKETS.USER_DOCUMENTS).getPublicUrl(fileName);
      uploadedUrls.push(publicUrlData.publicUrl);
      fs.unlinkSync(file.path);
    }

    await adminSupabase.from('users').update({ 
      verification_status: 'pending_verification', 
      document_type, 
      document_url: uploadedUrls.join(','), 
      updated_at: new Date() 
    }).eq('id', userId);

    res.status(200).json({ success: true, message: 'KYC Documents submitted successfully!' });
  } catch (error) {
    if (req.files) req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
