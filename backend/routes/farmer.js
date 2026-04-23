const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { supabase: adminSupabase, BUCKETS } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { sendPushNotification, sendSMS } = require('../utils/notifications');

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
 * GET /api/farmer/bids
 * Get all bids received on any listing posted by the farmer.
 */
router.get('/bids', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('bids')
      .select(`
        *,
        crop_listings!inner(farmer_id, variety),
        trader:users!trader_id(full_name, location)
      `)
      .eq('crop_listings.farmer_id', req.user.id)
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

/**
 * PUT /api/farmer/bid/:bidId/accept
 * Farmer accepts a bid, creating an order and notifying the trader.
 */
router.put('/bid/:bidId/accept', authenticateToken, async (req, res) => {
  try {
    const { bidId } = req.params;
    const { listing_id } = req.body;
    
    console.log(`[BID_ACCEPT] Starting acceptance for Bid: ${bidId}, Listing: ${listing_id}`);

    // 1. Fetch Bid (using adminSupabase to ensure we see it regardless of RLS)
    const { data: bid, error: bidErr } = await adminSupabase
      .from('bids')
      .select('trader_id, amount, quantity, status')
      .eq('id', bidId)
      .single();
      
    if (bidErr || !bid) {
      console.error('[BID_ACCEPT] Bid not found:', bidErr?.message);
      throw new Error('Bid not found');
    }

    // 2. Fetch Listing to ensure ownership
    const { data: listing, error: listingErr } = await adminSupabase
      .from('crop_listings')
      .select('farmer_id, status, variety')
      .eq('id', listing_id)
      .single();
      
    if (listingErr || !listing) {
      console.error('[BID_ACCEPT] Listing not found:', listingErr?.message);
      throw new Error('Listing not found');
    }
    
    if (listing.farmer_id !== req.user.id) {
      console.warn(`[BID_ACCEPT] Unauthorized: Farmer ${req.user.id} tried to accept bid on listing owned by ${listing.farmer_id}`);
      throw new Error('Unauthorized to accept this bid');
    }

    // 3. Verify Trader Exists (Recovery for deleted users)
    const { data: traderCheck } = await adminSupabase.from('users').select('id').eq('id', bid.trader_id).single();
    if (!traderCheck) {
      console.error(`[BID_ACCEPT] Trader ${bid.trader_id} no longer exists in users table.`);
      throw new Error('The trader for this bid no longer has an active account.');
    }

    // 4. RECOVERY: If bid is already accepted, check if order already exists.
    if (bid.status === 'accepted') {
      const { data: existingOrder } = await adminSupabase
        .from('orders')
        .select('*')
        .eq('bid_id', bidId)
        .maybeSingle();

      if (existingOrder) {
        return res.json({ success: true, message: 'Bid already accepted', data: existingOrder });
      }
    } else {
      // Normal path: Update bid status using adminSupabase to bypass any RLS edge cases
      const { error: updBidErr } = await adminSupabase
        .from('bids')
        .update({ status: 'accepted' })
        .eq('id', bidId);
      if (updBidErr) throw updBidErr;

      // Reject all other pending bids for this listing
      await adminSupabase
        .from('bids')
        .update({ status: 'rejected' })
        .eq('listing_id', listing_id)
        .neq('id', bidId)
        .eq('status', 'pending');

      // Mark listing as sold
      await adminSupabase
        .from('crop_listings')
        .update({ status: 'sold' })
        .eq('id', listing_id);
    }

    // 5. Create the Order
    const final_amount = bid.amount * bid.quantity;
    console.log(`[BID_ACCEPT] Creating order for Farmer: ${req.user.id}, Trader: ${bid.trader_id}, Amount: ${final_amount}`);
    
    const { data: order, error: orderErr } = await adminSupabase
      .from('orders')
      .insert([{
        listing_id,
        bid_id: bidId,
        farmer_id: req.user.id,
        trader_id: bid.trader_id,
        final_amount: final_amount,
        status: 'confirmed',
        payment_status: 'pending',
        status_history: [{ 
          status: 'confirmed', 
          timestamp: new Date().toISOString(), 
          actor: 'Farmer', 
          note: 'Order created upon bid acceptance' 
        }]
      }])
      .select().single();
      
    if (orderErr) {
      console.error('[BID_ACCEPT] Order insertion failed:', orderErr.message);
      throw orderErr;
    }

    // 6. Notify Trader
    const { data: trader } = await adminSupabase.from('users').select('phone').eq('id', bid.trader_id).single();
    if (trader?.phone) {
      await sendSMS(trader.phone, `KrishiSethu: Badhai ho! Farmer ne aapka ₹${bid.amount} ka bid accept kar liya hai. Aapki order tracking start ho gayi hai.`);
    }
    
    try {
      await sendPushNotification(bid.trader_id, {
        title: 'Bid Accepted! 🎉',
        body: `Farmer ne aapka ₹${bid.amount} ka bid accept kar liya hai.`,
        data: { order_id: order.id, type: 'BID_ACCEPTED' }
      });
    } catch (e) {
      console.warn('[BID_ACCEPT] Push notification failed:', e.message);
    }

    console.log(`[BID_ACCEPT] Success! Order ID: ${order.id}`);
    res.json({ success: true, message: 'Bid accepted successfully', data: order });
  } catch (error) {
    console.error('[BID_ACCEPT_EXCEPTION]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/farmer/order/:orderId/confirm-payment
 * Farmer confirms or disputes payment receipt.
 */
router.put('/order/:orderId/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { payment_status } = req.body; // 'paid' or 'not_paid'

    // 1. Fetch order and verify ownership
    const { data: order, error: fetchErr } = await adminSupabase
      .from('orders')
      .select('*, trader:users!trader_id(phone)')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');
    if (order.farmer_id !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    // 2. Update order
    const historyNote = payment_status === 'paid' 
      ? 'Farmer confirmed payment receipt' 
      : 'Farmer reported payment NOT received';

    const newEvent = {
        status: order.status,
        timestamp: new Date().toISOString(),
        actor: 'Farmer',
        note: historyNote
    };

    const updateData = {
      payment_status,
      status: payment_status === 'paid' ? 'paid' : order.status,
      status_history: [...(order.status_history || []), newEvent],
      updated_at: new Date()
    };

    const { error: updErr } = await adminSupabase.from('orders').update(updateData).eq('id', orderId);
    if (updErr) throw updErr;

    // 3. Notify Trader
    if (order.trader?.phone) {
      const msg = payment_status === 'paid'
        ? `KrishiSethu: Farmer ne Order #${orderId.slice(0, 8)} ka payment accept kar liya hai. Dhanyawad!`
        : `KrishiSethu: ALERT! Farmer ne Order #${orderId.slice(0, 8)} ka payment received nahi honey ki report di hai.`;
      await sendSMS(order.trader.phone, msg);
    }

    try {
      await sendPushNotification(order.trader_id, {
        title: payment_status === 'paid' ? 'Payment Confirmed! 💰' : 'Payment Dispute! ⚠️',
        body: payment_status === 'paid' 
          ? `Farmer ne payment receive kar liya hai.` 
          : `Farmer bol rahe hain ki payment nahi mila.`,
        data: { order_id: orderId, type: 'PAYMENT_CONFIRMATION' }
      });
    } catch (e) { /* ignore */ }

    res.json({ success: true, message: 'Payment status updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
