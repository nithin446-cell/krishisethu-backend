const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { supabase: adminSupabase, BUCKETS } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { sendSMS, sendPushNotification } = require('../utils/notifications');

// Multer and S3 setup for Delivery Proof photos
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const upload = multer({ dest: UPLOADS_DIR });

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
 * GET /api/orders/:id
 * Retrieve full order details including participants and crop info.
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // Step 1: Fetch the order row + crop/bid info using adminSupabase to bypass RLS issues
    // while we manually verify ownership below. This avoids the "Cannot coerce result" error
    // when RLS policies are too restrictive for finished orders.
    const { data, error } = await adminSupabase
      .from('orders')
      .select(`
        *,
        crop_listings(variety, unit, crop_pictures(image_url)),
        bid:bids(amount, quantity)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !data) throw new Error(error?.message || 'Order not found');

    // Step 2: Manual Security Check
    const isFarmer = req.user.id === data.farmer_id;
    const isTrader = req.user.id === data.trader_id;
    const isAdmin = req.user.role === 'admin';

    if (!isFarmer && !isTrader && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Unauthorized to view this order' });
    }

    // Step 3: Fetch farmer and trader separately to guarantee correct user data
    const [farmerResult, traderResult] = await Promise.all([
      adminSupabase.from('users').select('full_name, phone, location').eq('id', data.farmer_id).single(),
      adminSupabase.from('users').select('full_name, phone, location, business_name').eq('id', data.trader_id).single()
    ]);

    const farmer = farmerResult.data;
    const trader = traderResult.data;

    // Format for frontend component compatibility
    const formattedData = {
      ...data,
      crop_name: data.crop_listings?.variety || 'Unknown Crop',
      unit: data.crop_listings?.unit || 'kg',
      agreed_price: data.bid?.amount || 0,
      quantity: data.bid?.quantity || 0,
      produce_image_url: data.crop_listings?.crop_pictures?.[0]?.image_url || null,
      farmer_name: farmer?.full_name || 'Unknown Farmer',
      farmer_phone: farmer?.phone || '',
      farmer_village: farmer?.location || '',
      trader_name: trader?.business_name || trader?.full_name || 'Unknown Trader',
      trader_phone: trader?.phone || '',
      trader_city: trader?.location || ''
    };

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/orders/:id/status
 * Update order status (Dispatch, Confirm, etc.) and notify the other party.
 */
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, dispatch_note, vehicle_number, estimated_days } = req.body;
    const orderId = req.params.id;

    const { data: order, error: fetchErr } = await adminSupabase
      .from('orders')
      .select('*, farmer:users!farmer_id(phone), trader:users!trader_id(phone)')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');

    const isFarmer = req.user.id === order.farmer_id;
    const isTrader = req.user.id === order.trader_id;
    if (!isFarmer && !isTrader) return res.status(403).json({ error: 'Unauthorized to update this order' });

    // 1. Use RPC for Atomic History Append and Status Update
    const { error: rpcErr } = await adminSupabase.rpc('append_order_history', {
      p_order_id: orderId,
      p_status: status,
      p_note: dispatch_note || (status === 'confirmed' ? 'Order accepted by farmer' : `Status updated to ${status}`),
      p_actor: isFarmer ? 'Farmer' : 'Trader'
    });

    if (rpcErr) throw rpcErr;

    // 2. Additional metadata updates for specific statuses (dispatch details)
    if (status === 'dispatched') {
      await adminSupabase.from('orders').update({
        dispatched_at: new Date(),
        vehicle_number,
        estimated_days: parseInt(estimated_days)
      }).eq('id', orderId);
    } else if (status === 'confirmed') {
      await adminSupabase.from('orders').update({ confirmed_at: new Date() }).eq('id', orderId);
    }

    // 2. Notifications
    const recipientPhone = isFarmer ? order.trader?.phone : order.farmer?.phone;
    const targetUserId = isTrader ? order.farmer_id : order.trader_id;

    if (recipientPhone) {
      let msg = `KrishiSethu: Order #${orderId.slice(0, 8)} status updated to ${status}.`;
      if (status === 'dispatched') {
        msg = `KrishiSethu: Aapka Order #${orderId.slice(0, 8)} bhej diya gaya hai! Track in app.`;
      }
      await sendSMS(recipientPhone, msg);
    }

    try {
      await sendPushNotification(targetUserId, {
        title: 'Order Update / Order update mila',
        body: `Order #${orderId.slice(0, 8)} ab ${status} hai.`,
        data: { order_id: orderId, type: 'ORDER_UPDATE' }
      });
    } catch (e) { /* silent fail for fcm */ }

    res.json({ success: true, message: `Order status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/orders/:id/deliver
 * Trader confirms delivery of the goods, readying payment for the farmer.
 */
router.put('/:id/deliver', authenticateToken, upload.single('delivery_photo'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const { delivery_note } = req.body;

    const { data: order, error: fetchErr } = await adminSupabase
      .from('orders')
      .select('*, farmer:users!farmer_id(phone)')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');
    if (req.user.id !== order.trader_id) return res.status(403).json({ error: 'Only the trader can confirm delivery' });

    let photoUrl = null;
    if (req.file) {
      const fileName = `delivery-${orderId}-${Date.now()}${path.extname(req.file.originalname)}`;
      await s3Client.send(new PutObjectCommand({ Bucket: BUCKETS.ORDER_PHOTOS, Key: fileName, Body: fs.readFileSync(req.file.path), ContentType: req.file.mimetype }));
      const { data: publicUrlData } = adminSupabase.storage.from(BUCKETS.ORDER_PHOTOS).getPublicUrl(fileName);
      photoUrl = publicUrlData.publicUrl;
      fs.unlinkSync(req.file.path);
    }

    // 1. Update delivery details
    await adminSupabase.from('orders').update({
      payment_status: 'processing',
      delivered_at: new Date(),
      delivery_photo_url: photoUrl,
      delivery_note: delivery_note || null,
    }).eq('id', orderId);

    // 2. Atomic History Append
    const { error: rpcErr } = await adminSupabase.rpc('append_order_history', {
      p_order_id: orderId,
      p_status: 'delivered',
      p_note: delivery_note || 'Trader confirmed delivery of goods',
      p_actor: 'Trader'
    });

    if (rpcErr) throw rpcErr;

    if (order.farmer?.phone) {
      await sendSMS(order.farmer.phone, `KrishiSethu: Saman mil gaya! Trader ne delivery confirm kar di hai. Payment release ho raha hai.`);
    }

    res.json({ success: true, message: 'Delivery confirmed successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/orders/:id/dispute
 * Raise a dispute for an order.
 */
router.post('/:id/dispute', authenticateToken, async (req, res) => {
  try {
    const { reason, details } = req.body;
    const { error } = await adminSupabase.from('order_disputes').insert([{
      order_id: req.params.id,
      raised_by: req.user.id,
      reason,
      details,
      status: 'open'
    }]);
    if (error) throw error;
    res.json({ success: true, message: 'Dispute submitted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/rating
 * Submit rating and feedback for an order.
 */
router.post('/:id/rating', authenticateToken, async (req, res) => {
  try {
    const { rating, note } = req.body;
    const orderId = req.params.id;

    const { data: order, error: fetchErr } = await adminSupabase
      .from('orders')
      .select('status_history')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');

    // 1. Submit Rating
    const { error: updateErr } = await adminSupabase
      .from('orders')
      .update({
        rating: rating,
        rating_note: note
      })
      .eq('id', orderId);

    if (updateErr) throw updateErr;

    // 2. Atomic History Append
    const { error: rpcErr } = await adminSupabase.rpc('append_order_history', {
      p_order_id: orderId,
      p_status: 'rated',
      p_note: `User rated this transaction ${rating} stars: ${note || 'No comment'}`,
      p_actor: 'System'
    });

    if (rpcErr) throw rpcErr;

    res.json({ success: true, message: 'Rating submitted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
