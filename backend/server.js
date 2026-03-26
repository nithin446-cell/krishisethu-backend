const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load env based on NODE_ENV: .env.production in prod, .env.development in dev
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: `${__dirname}/${envFile}` });
// Fallback to plain .env if specific file doesn't exist
dotenv.config({ path: `${__dirname}/.env` });

const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const FormData = require('form-data');
const axios = require('axios');
const { sendPushNotification } = require('./notificationHelper');

const app = express();
app.use(cors());

// 🔌 Initialize express-ws for WebSocket support (chat rooms)
const expressWs = require('express-ws')(app);
const chatRooms = {}; // { order_id: Set<WebSocket> }
const globalConnections = new Map(); // { user_id: WebSocket }

// 🚀 Increased payload limits for large CSV files
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL?.trim();
if (!supabaseUrl) {
  console.error('Environment variable SUPABASE_URL is not defined.');
  process.exit(1);
}

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize S3 Client
const s3Client = new S3Client({
  forcePathStyle: true,
  region: 'ap-south-1',
  endpoint: `${supabaseUrl}/storage/v1/s3`,
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim(),
  }
});

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const token = authHeader.split(' ')[1];
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ success: false, error: 'Invalid token' });

    req.user = data.user;
    req.userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Auth failed' });
  }
};

// ==========================================
// SMS HELPER (Fast2SMS)
// ==========================================
const sendSMS = async (phones, message) => {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.warn('[SMS] FAST2SMS_API_KEY not set — skipping SMS');
    return;
  }
  // phones can be a single string or array; Fast2SMS accepts comma-separated
  const numbers = Array.isArray(phones) ? phones.join(',') : phones;
  if (!numbers) return;
  try {
    const res = await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      { route: 'q', message, language: 'english', flash: 0, numbers },
      { headers: { authorization: apiKey }, timeout: 8000 }
    );
    if (res.data?.return !== true)
      console.warn('[SMS] Fast2SMS response:', res.data);
    else
      console.log(`[SMS] Sent to ${numbers}`);
  } catch (err) {
    console.error('[SMS] Failed to send:', err.message);
  }
};

// ==========================================
// AUTH & USERS
// ==========================================
app.get('/api/user/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, full_name, role, phone, location, business_name } = req.body;
  try {
    // 🛑 SECURITY LOCKDOWN: Block fake admin signups
    if (role === 'admin') {
      return res.status(403).json({ success: false, error: 'Unauthorized: Cannot create admin accounts via public signup.' });
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
    if (authError) throw authError;

    const { data: userData, error: userError } = await supabase.from('users').insert([{
      id: authData.user.id, role, full_name, phone, email, location, business_name
    }]).select().single();
    if (userError) throw userError;

    res.status(201).json({ success: true, message: 'Account created', user: userData, session: authData.session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// MARKET FEED
// ==========================================
app.get('/api/market', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.from('crop_listings').select(`*, users ( full_name, location, business_name ), crop_pictures ( image_url ), bids ( * )`).eq('status', 'active').order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data.map(item => ({ ...item, images: item.crop_pictures?.map(pic => pic.image_url) || [] })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/market-prices', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('market_prices').select('*').order('price_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// FARMER PORTAL
// ==========================================
app.post('/api/farmer/upload', authenticateToken, upload.array('images', 5), async (req, res) => {
  try {
    const { crop_name, variety, quantity, unit, base_price, location, description, status } = req.body;
    const farmer_id = req.body.farmer_id || req.user.id;

    const { data: listingData, error: listingError } = await req.userSupabase.from('crop_listings').insert([{ farmer_id, variety: variety || crop_name, quantity: parseFloat(quantity), unit, current_price: parseFloat(base_price), location, description, status: status || 'active' }]).select().single();
    if (listingError) throw listingError;

    if (req.files) {
      for (const file of req.files) {
        const fileName = `${listingData.id}-${Date.now()}${path.extname(file.originalname)}`;
        await s3Client.send(new PutObjectCommand({ Bucket: 'crop_pictures', Key: `${farmer_id}/${fileName}`, Body: fs.readFileSync(file.path), ContentType: file.mimetype }));
        const { data: publicUrlData } = supabase.storage.from('crop_pictures').getPublicUrl(`${farmer_id}/${fileName}`);
        await req.userSupabase.from('crop_pictures').insert([{ listing_id: listingData.id, image_url: publicUrlData.publicUrl }]);
        fs.unlinkSync(file.path);
      }
    }
    res.status(201).json({ message: 'Produce listed successfully', data: listingData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/farmer/listings', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.from('crop_listings').select(`*, bids ( id, trader_id, amount, quantity, status, created_at, users (full_name) )`).eq('farmer_id', req.user.id).in('status', ['active', 'sold']).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/farmer/orders', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.from('orders').select(`*, crop_listings (variety, unit), trader:users!trader_id (business_name, full_name, phone, location)`).eq('farmer_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { data, error } = await req.userSupabase
      .from('orders')
      .select(`
        *,
        crop_listings(variety, unit),
        bid:bids(amount, quantity),
        farmer:users!farmer_id(full_name, phone, location),
        trader:users!trader_id(full_name, phone, location, business_name)
      `)
      .eq('id', orderId)
      .single();

    if (error || !data) throw new Error(error?.message || 'Order not found');

    // Format data to match what OrderTracking.tsx expects
    const formattedData = {
      ...data,
      crop_name: data.crop_listings?.crop_name || data.crop_listings?.variety || 'Unknown Crop',
      unit: data.crop_listings?.unit || 'kg',
      agreed_price: data.bid?.amount || 0,
      quantity: data.bid?.quantity || 0,
      farmer_name: data.farmer?.full_name || 'Unknown Farmer',
      farmer_phone: data.farmer?.phone || '',
      farmer_village: data.farmer?.location || '',
      trader_name: data.trader?.business_name || data.trader?.full_name || 'Trader',
      trader_phone: data.trader?.phone || '',
      trader_city: data.trader?.location || ''
    };

    res.status(200).json({ success: true, data: formattedData });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

// ==========================================
// ORDER TRACKING ACTIONS
// ==========================================

// New Route: Update Status (Confirm/Dispatch)
app.put('/api/orders/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, dispatch_note, vehicle_number, estimated_days } = req.body;
    const orderId = req.params.id;

    // Fetch order + parties for authorization and notifications
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('*, farmer:users!farmer_id(full_name, phone), trader:users!trader_id(full_name, phone)')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');

    const isFarmer = req.user.id === order.farmer_id;
    const isTrader = req.user.id === order.trader_id;
    if (!isFarmer && !isTrader) return res.status(403).json({ error: 'Unauthorized to update this order' });

    // ── Build new history event ──
    const newEvent = {
       status,
       timestamp: new Date().toISOString(),
       actor: isFarmer ? 'Farmer' : 'Trader',
       note: dispatch_note || (status === 'confirmed' ? 'Order accepted by farmer' : `Status updated to ${status}`)
    };

    const updatedHistory = [...(order.status_history || []), newEvent];

    // ── Prepare update data ──
    const updateData = {
      status,
      status_history: updatedHistory,
      updated_at: new Date()
    };

    if (status === 'dispatched') {
      updateData.dispatched_at = new Date();
      updateData.dispatch_note = dispatch_note;
      updateData.vehicle_number = vehicle_number;
      updateData.estimated_days = parseInt(estimated_days);
    } else if (status === 'confirmed') {
      updateData.confirmed_at = new Date();
    }

    const { error: updateErr } = await supabase.from('orders').update(updateData).eq('id', orderId);
    if (updateErr) throw updateErr;

    // ── SMS Notifications ──
    try {
      const recipientPhone = isFarmer ? order.trader?.phone : order.farmer?.phone;
      if (recipientPhone) {
        let msg = `KrishiSethu: Order #${orderId.slice(0, 8)} status updated to ${status}.`;
        if (status === 'dispatched') {
          msg = `KrishiSethu: Aapka Order #${orderId.slice(0, 8)} bhej diya gaya hai! Vehicle: ${vehicle_number || 'N/A'}. Track in app.`;
        } else if (status === 'confirmed') {
          msg = `KrishiSethu: Farmer ne aapka bid accept kar liya hai! Order #${orderId.slice(0, 8)} confirmed.`;
        }
        await sendSMS(recipientPhone, msg);
      }
    } catch (smsErr) { console.error('[SMS_ERROR]', smsErr.message); }

    // ── FCM Notifications ──
    try {
      const isTrader = req.user.id === order.trader_id;
      const targetUserId = isTrader ? order.farmer_id : order.trader_id;
      const title = status === 'dispatched' ? 'Mal Bhej Diya Gaya!' : 'Order Status Update';
      const body = status === 'dispatched' 
        ? `KrishiSethu: Order #${orderId.slice(0, 8)} dispatched. Vehicle: ${vehicle_number || 'N/A'}`
        : `KrishiSethu: Aapka Order #${orderId.slice(0, 8)} ab ${status} hai.`;
      
      await sendPushNotification(targetUserId, { title, body, data: { order_id: orderId, type: 'ORDER_UPDATE' } });
    } catch (fcmErr) { console.error('[FCM_ERROR]', fcmErr.message); }

    res.json({ success: true, message: `Order status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// New Route: Confirm Delivery with Proof
app.put('/api/orders/:id/deliver', authenticateToken, upload.single('delivery_photo'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const { delivery_note } = req.body;

    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('*, farmer:users!farmer_id(full_name, phone)')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) throw new Error('Order not found');
    if (req.user.id !== order.trader_id) return res.status(403).json({ error: 'Only the trader can confirm delivery' });

    let photoUrl = null;
    if (req.file) {
      try {
        const fileName = `delivery-${orderId}-${Date.now()}${path.extname(req.file.originalname)}`;
        await s3Client.send(new PutObjectCommand({ 
          Bucket: 'order-photos', 
          Key: fileName, 
          Body: fs.readFileSync(req.file.path), 
          ContentType: req.file.mimetype 
        }));
        const { data: publicUrlData } = supabase.storage.from('order-photos').getPublicUrl(fileName);
        photoUrl = publicUrlData.publicUrl;
        fs.unlinkSync(req.file.path);
      } catch (s3Err) {
        console.error('[S3_UPLOAD_ERROR]', s3Err);
        // Continue without photo if upload fails, but log it
      }
    }

    const newEvent = {
      status: 'delivered',
      timestamp: new Date().toISOString(),
      actor: 'Trader',
      note: delivery_note || 'Delivery confirmed by trader'
    };

    const { error: updateErr } = await supabase.from('orders').update({
      status: 'delivered',
      payment_status: 'processing', // Ready for release
      delivered_at: new Date(),
      delivery_note,
      delivery_photo_url: photoUrl,
      status_history: [...(order.status_history || []), newEvent],
      updated_at: new Date()
    }).eq('id', orderId);

    if (updateErr) throw updateErr;

    // 📱 SMS to Farmer: Delivery confirmed, money incoming
    if (order.farmer?.phone) {
      await sendSMS(order.farmer.phone, `KrishiSethu: Saman mil gaya! Trader ne delivery confirm kar di hai. Payment release ho raha hai.`);
    }

    // ── FCM Notification ──
    await sendPushNotification(order.farmer_id, {
      title: 'Mal Mil Gaya!',
      body: 'Trader ne delivery confirm kar di hai. Payment release ho raha hai.',
      data: { order_id: orderId, type: 'DELIVERY_CONFIRMED' }
    });

    res.json({ success: true, message: 'Delivery confirmed successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// New Route: Raise Issue/Dispute
app.post('/api/orders/:id/dispute', authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { reason, details } = req.body;

    const { data: order, error: fetchErr } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (fetchErr || !order) throw new Error('Order not found');

    const isParty = req.user.id === order.farmer_id || req.user.id === order.trader_id;
    if (!isParty) return res.status(403).json({ error: 'Unauthorized party' });

    // 1. Create entry in disputes table
    const { error: disputeErr } = await supabase.from('order_disputes').insert([{
      order_id: orderId,
      raised_by: req.user.id,
      reason,
      details,
      status: 'open'
    }]);
    if (disputeErr) throw disputeErr;

    // 2. Mark order as disputed
    const newEvent = {
      status: 'disputed',
      timestamp: new Date().toISOString(),
      actor: req.user.id === order.farmer_id ? 'Farmer' : 'Trader',
      note: `Dispute raised: ${reason}`
    };

    await supabase.from('orders').update({
      status: 'disputed',
      dispute_reason: reason,
      dispute_details: details,
      disputed_by: req.user.id,
      disputed_at: new Date(),
      status_history: [...(order.status_history || []), newEvent],
      updated_at: new Date()
    }).eq('id', orderId);

    // ── FCM Notification ──
    try {
      const targetUserId = req.user.id === order.farmer_id ? order.trader_id : order.farmer_id;
      await sendPushNotification(targetUserId, {
        title: 'Dispute Raised',
        body: `KrishiSethu: Order #${orderId.slice(0, 8)} par dispute raise kiya gaya hai: ${reason}`,
        data: { order_id: orderId, type: 'DISPUTE_RAISED' }
      });
    } catch (fcmErr) { console.error('[FCM] Dispute notification failed:', fcmErr.message); }

    res.json({ success: true, message: 'Dispute submitted. We will investigate.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/farmer/order/:id/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const farmerId = req.user.id;

    // Fetch Razorpay helper
    const razorpayFetch = async (path, method = 'GET', body = null) => {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const res = await fetch(`https://api.razorpay.com/v1${path}`, {
        method, headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: body ? JSON.stringify(body) : null,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.description || 'Razorpay API error');
      return data;
    };

    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('farmer_id', farmerId)
      .single();

    if (!order) throw new Error('Order not found');
    if (order.payment_status === 'paid') throw new Error('Already confirmed');

    let payoutResult = null;

    if (order.route_transfer_linked) {
      // ── OPTION A: Release held Route transfer (Razorpay Route)
      const transfers = await razorpayFetch(`/orders/${order.razorpay_order_id}/transfers`);
      const transfer = transfers.items?.[0];

      if (transfer && transfer.on_hold) {
        payoutResult = await razorpayFetch(`/transfers/${transfer.id}`, 'PATCH', {
          on_hold: 0, // Release funds!
        });
      }
    } else if (order.farmer_fund_account_id) {
      // ── OPTION B: Manual RazorpayX Payout
      const totalPaise = Math.round(order.final_amount * 100);
      const farmerAmountPaise = Math.round(totalPaise * 0.97); // minus 3%

      payoutResult = await razorpayFetch('/payouts', 'POST', {
        account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
        fund_account_id: order.farmer_fund_account_id,
        amount: farmerAmountPaise,
        currency: 'INR',
        mode: 'IMPS',
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: orderId,
        narration: `KrishiSethu payment ${orderId.slice(0, 8)}`,
      });
    }

    // Update order
    await supabase.from('orders').update({
      payment_status: 'paid',
      payout_reference: payoutResult?.id || null,
      farmer_confirmed_at: new Date(),
      updated_at: new Date(),
    }).eq('id', orderId);

    // 📱 SMS: Confirm payout to farmer
    try {
      const { data: farmer } = await supabase.from('users').select('phone').eq('id', farmerId).single();
      if (farmer?.phone) {
        const msg = payoutResult
          ? `KrishiSethu: Aapka payment aapke bank account me transfer ho gaya hai! Reference: ${payoutResult.id?.slice(0, 12)}`
          : `KrishiSethu: Delivery confirm ho gayi. Payment 24 ghante me aapke account me aa jayega.`;
        await sendSMS(farmer.phone, msg);
      }
    } catch (smsErr) {
      console.error('[SMS] Payout notification failed:', smsErr.message);
    }

    // ── FCM Notification ──
    await sendPushNotification(farmerId, {
      title: 'Payment Released!',
      body: payoutResult 
        ? `KrishiSethu: Aapka payment transfer kar diya gaya hai. Ref: ${payoutResult.id?.slice(0, 8)}`
        : `KrishiSethu: Delivery confirmed. Payment processing me hai.`,
      data: { order_id: orderId, type: 'PAYMENT_RELEASED' }
    });

    res.json({
      success: true,
      message: payoutResult
        ? 'Payment released to your bank account!'
        : 'Confirmed. Payment will be processed within 24 hours.',
      payout_id: payoutResult?.id || null,
    });
  } catch (err) {
    console.error('Confirm payment error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/farmer/bid/:id/accept', authenticateToken, async (req, res) => {
  try {
    const { listing_id } = req.body;
    // ⚡ Atomic transaction via Supabase RPC — prevents race conditions
    const { error } = await req.userSupabase.rpc('accept_bid', {
      p_bid_id: req.params.id,
      p_listing_id: listing_id
    });
    if (error) throw error;

    // 📱 SMS: Notify trader their bid was accepted
    try {
      const { data: bid } = await supabase.from('bids').select('trader_id, amount, quantity').eq('id', req.params.id).single();
      if (bid?.trader_id) {
        const { data: trader } = await supabase.from('users').select('phone').eq('id', bid.trader_id).single();
        const { data: farmer } = await supabase.from('users').select('full_name').eq('id', req.user.id).single();
        if (trader?.phone) {
          await sendSMS(trader.phone, `KrishiSethu: ${farmer?.full_name || 'Farmer'} ne aapka ₹${bid.amount}/kg bid accept kar liya. App me order dekhe aur payment karein.`);
        }

        // ── FCM Notification ──
        await sendPushNotification(bid.trader_id, {
          title: 'Bid Accepted!',
          body: `KrishiSethu: ${farmer?.full_name || 'Farmer'} ne aapka ₹${bid.amount}/kg bid accept kar liya. Ab payment karein.`,
          data: { bid_id: req.params.id, type: 'BID_ACCEPTED' }
        });
      }
    } catch (smsErr) {
      console.error('[SMS] Bid-accept notification failed:', smsErr.message);
    }

    res.status(200).json({ message: 'Bid accepted successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// TRADER PORTAL
// ==========================================
app.post('/api/trader/bid', authenticateToken, async (req, res) => {
  try {
    const { listing_id, amount, quantity, message } = req.body;
    const { data, error } = await req.userSupabase.from('bids').insert([{ listing_id, trader_id: req.user.id, amount, quantity, message }]).select().single();
    if (error) throw error;

    // ⚡ Real-time Notification: Notify the farmer if they are online
    try {
      const { data: listing } = await supabase.from('crop_listings').select('farmer_id').eq('id', listing_id).single();
      if (listing?.farmer_id) {
        const farmerWs = globalConnections.get(listing.farmer_id);
        if (farmerWs && farmerWs.readyState === 1) {
          farmerWs.send(JSON.stringify({
            type: 'NEW_BID',
            data: {
              ...data,
              trader_name: req.user.user_metadata?.full_name || 'A Trader',
              timestamp: new Date().toISOString()
            }
          }));
        }
      }
    } catch (wsErr) {
      console.error('Failed to send bid notification:', wsErr);
    }

    // 📱 SMS: Notify farmer of new bid
    try {
      const { data: listing } = await supabase.from('crop_listings').select('farmer_id').eq('id', listing_id).single();
      if (listing?.farmer_id) {
        const { data: farmer } = await supabase.from('users').select('phone, full_name').eq('id', listing.farmer_id).single();
        if (farmer?.phone) {
          const traderName = req.user.user_metadata?.full_name || 'A trader';
          await sendSMS(farmer.phone, `KrishiSethu: ${traderName} ne aapki fasal par ₹${amount}/kg ka bid lagaya hai. App me dekhein.`);
        }

        // ── FCM Notification ──
        await sendPushNotification(listing.farmer_id, {
          title: 'New Bid Received!',
          body: `${req.user.user_metadata?.full_name || 'A trader'} ne aapkia fasal par ₹${amount}/kg ka bid lagaya hai.`,
          data: { listing_id, type: 'NEW_BID' }
        });
      }
    } catch (smsErr) {
      console.error('[SMS] Bid notification failed:', smsErr.message);
    }

    res.status(201).json({ message: 'Bid placed', data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/trader/bids', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.from('bids').select(`*, crop_listings (variety, current_price, status)`).eq('trader_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/trader/orders', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('orders')
      .select(`*, crop_listings (variety, unit, location), farmer:users!farmer_id (full_name, phone), bids (quantity)`)
      .eq('trader_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// PAYMENTS (RAZORPAY)
// ==========================================
app.post('/api/payment/create', authenticateToken, async (req, res) => {
  try {
    const { listing_id, Math: _m, amount: rawAmount, order_id: customReceipt, quantity = 1, agreed_price } = req.body;
    const traderId = req.user.id;

    // We fall back to rawAmount if agreed_price and quantity aren't properly passed for cart flows
    const effectivePrice = agreed_price || rawAmount;
    const effectiveQty = quantity || 1;

    // Get listing + farmer's linked account
    const { data: listing } = await supabase
      .from('crop_listings')
      .select('*, users!farmer_id(id, full_name)')
      .eq('id', listing_id)
      .single();

    const { data: bankAccount } = await supabase
      .from('bank_accounts')
      .select('razorpay_linked_account_id, razorpay_fund_account_id, is_verified')
      .eq('user_id', listing?.farmer_id)
      .maybeSingle();

    const totalPaise = Math.round(rawAmount * 100) || Math.round(effectivePrice * effectiveQty * 100);
    const platformFeePaise = Math.round(totalPaise * 0.03); // 3% platform fee
    const farmerAmountPaise = totalPaise - platformFeePaise;

    const farmerLinkedAccId = bankAccount?.razorpay_linked_account_id;
    const farmerFundAccId = bankAccount?.razorpay_fund_account_id;
    const farmerBankVerified = bankAccount?.is_verified;

    // Build Razorpay order — with Route transfer if farmer has verified account
    const orderPayload = {
      amount: totalPaise,
      currency: 'INR',
      receipt: customReceipt || `order_${Date.now()}`,
      notes: { listing_id, trader_id: traderId, farmer_id: listing?.farmer_id },
    };

    // Add Route transfer if farmer's linked account exists
    if (farmerLinkedAccId && farmerBankVerified) {
      orderPayload.transfers = [{
        account: farmerLinkedAccId,
        amount: farmerAmountPaise,
        currency: 'INR',
        on_hold: 1, // Hold until farmer confirms delivery
        on_hold_until: Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000), // 7 days max
        notes: { reason: 'Farmer payment for KrishiSethu order' },
      }];
    }

    const razorpayOrder = await razorpay.orders.create(orderPayload);
    res.status(200).json({
      success: true,
      razorpay_order_id: razorpayOrder.id,
      amount: totalPaise,
      farmer_bank_linked: !!farmerLinkedAccId,
      platform_fee: platformFeePaise / 100,
      farmer_receives: farmerAmountPaise / 100,
      farmer_fund_account_id: farmerFundAccId || null
    });
  } catch (error) {
    console.error('Payment create error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payment/verify', authenticateToken, async (req, res) => {
  try {
    const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expectedSignature !== razorpay_signature) return res.status(400).json({ success: false, error: 'Invalid payment signature.' });

    await supabase.from('orders').update({ status: 'completed', payment_status: 'processing', razorpay_payment_id, updated_at: new Date() }).eq('id', order_id);

    // 📱 SMS: Notify farmer payment received, delivery pending
    try {
      const { data: order } = await supabase.from('orders').select('farmer_id, final_amount').eq('id', order_id).single();
      if (order?.farmer_id) {
        const { data: farmer } = await supabase.from('users').select('phone').eq('id', order.farmer_id).single();
        if (farmer?.phone) {
          await sendSMS(farmer.phone, `KrishiSethu: Trader ne ₹${order.final_amount} payment ki hai. Fasal deliver karein aur app me confirm karein taaki payment aapke account me aaye.`);
        }
      }
    } catch (smsErr) {
      console.error('[SMS] Payment verify notification failed:', smsErr.message);
    }

    res.status(200).json({ success: true, message: 'Payment verified!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔔 Razorpay Webhook — server-side payment confirmation fallback
// Ensures payment_status updates even if user's browser closes mid-checkout
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).json({ error: 'Webhook secret not configured' });

    const isValid = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.body.toString())
      .digest('hex') === signature;

    if (!isValid) return res.status(400).json({ error: 'Invalid webhook signature' });

    const event = JSON.parse(req.body);
    if (event.event === 'payment.captured') {
      const orderId = event.payload.payment.entity.receipt;
      // Use service role for webhook updates (no user context available)
      supabase.from('orders')
        .update({ payment_status: 'processing', status: 'completed', updated_at: new Date() })
        .eq('id', orderId)
        .then(({ error }) => { if (error) console.error('Webhook order update failed:', error); });
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CHAT SYSTEM
// ==========================================
app.get('/api/chat/:order_id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase.from('messages').select('*').eq('order_id', req.params.order_id).order('created_at', { ascending: true });
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { order_id, receiver_id, content } = req.body;
    const senderId = req.user.id;

    console.log(`[CHAT_DEBUG] Incoming: order_id=${order_id}, sender=${senderId}, receiver=${receiver_id}`);

    // Skip verification for pre-order direct contact flows
    if (!order_id?.startsWith('direct_')) {
      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('farmer_id, trader_id')
        .eq('id', order_id)
        .single();

      if (orderErr || !order) {
        console.error(`[CHAT_ERROR] Order verification failed:`, orderErr || 'No order found');
        return res.status(404).json({ error: `Order not found (${order_id}). ${orderErr?.message || ''}` });
      }

      console.log(`[CHAT_DEBUG] Verified party: farmer=${order.farmer_id}, trader=${order.trader_id}`);

      const isParty = senderId === order.farmer_id || senderId === order.trader_id;
      if (!isParty) {
        return res.status(403).json({ error: 'You are not a participant of this order.' });
      }

      const expectedReceiver = senderId === order.farmer_id ? order.trader_id : order.farmer_id;
      if (receiver_id !== expectedReceiver) {
        return res.status(403).json({ error: 'Invalid receiver for this order.' });
      }
    }

    const { data, error } = await req.userSupabase
      .from('messages')
      .insert([{ order_id, sender_id: senderId, receiver_id, content }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



app.post('/api/user/kyc', authenticateToken, upload.array('documents', 5), async (req, res) => {
  try {
    const { document_type } = req.body;
    const userId = req.user.id;

    if (!req.files || req.files.length === 0) throw new Error('No document images uploaded');

    const uploadedUrls = [];
    for (const file of req.files) {
      const fileExt = path.extname(file.originalname);
      const fileName = `${userId}-${Date.now()}-${Math.round(Math.random() * 1000)}${fileExt}`;
      await s3Client.send(new PutObjectCommand({ Bucket: 'user_documents', Key: fileName, Body: fs.readFileSync(file.path), ContentType: file.mimetype }));
      const { data: publicUrlData } = supabase.storage.from('user_documents').getPublicUrl(fileName);
      uploadedUrls.push(publicUrlData.publicUrl);
      fs.unlinkSync(file.path);
    }

    const { data, error } = await supabase.from('users').update({ verification_status: 'pending_verification', document_type: document_type, document_url: uploadedUrls.join(','), updated_at: new Date() }).eq('id', userId).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: 'KYC Documents submitted successfully!', data });
  } catch (error) {
    if (req.files) req.files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// SUREPASS KYC INTEGRATION
// ==========================================
app.post('/api/user/kyc/surepass', authenticateToken, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No document uploaded.');

    const formData = new FormData();
    formData.append('file', fs.createReadStream(req.file.path));

    // Call Surepass API (Replace the URL with specific Aadhaar/PAN endpoint if necessary)
    // Note: sandbox URL is used below, swap to production URL for live deployments.
    const surepassRes = await axios.post('https://sandbox.surepass.io/api/v1/ocr/aadhaar', formData, {
      headers: {
        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
        ...formData.getHeaders()
      }
    });

    const surepassData = surepassRes.data;

    // Clean up local temp file
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    if (surepassData.status_code !== 200 || !surepassData.data) {
      throw new Error(`Surepass Error: ${surepassData.message || 'Verification failed.'}`);
    }

    // Update user verification status securely utilizing the Service Role Key implicitly on the backend
    const { error } = await supabase
      .from('users')
      .update({
        verification_status: 'verified',
        updated_at: new Date()
      })
      .eq('id', req.user.id);

    if (error) throw error;

    res.json({ success: true, message: 'KYC verified successfully via Surepass.', data: surepassData.data });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('Surepass proxy error:', error?.response?.data || error.message);
    res.status(500).json({ success: false, error: error?.response?.data?.message || error.message || 'Internal server error' });
  }
});

// ==========================================
// BULK PRICE UPLOAD (MUST BE HERE)
// ==========================================
const csv = require('csv-parser');

app.post('/api/admin/prices/upload-csv', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No CSV file uploaded.' });
  }

  const results = [];
  const BATCH_SIZE = 5000;
  let totalInserted = 0;
  let hasError = false;

  const stream = fs.createReadStream(req.file.path).pipe(csv());

  stream.on('data', async (data) => {
    // Basic validation & transformation
    if (data['Crop Name'] || data.crop_name) {
      results.push({
        crop_name: data['Crop Name'] || data.crop_name,
        variety: data['Variety'] || data.variety || 'Standard',
        market_name: data['Market Name'] || data.market_name,
        min_price: parseFloat(data['Min Price'] || data.min_price) || 0,
        max_price: parseFloat(data['Max Price'] || data.max_price) || 0,
        modal_price: parseFloat(data['Modal Price'] || data.modal_price) || 0,
      });
    }

    // Process in batches
    if (results.length >= BATCH_SIZE) {
      stream.pause(); // Pause reading while we insert
      const batchToInsert = [...results];
      results.length = 0; // Clear array for next batch

      try {
        const { error } = await supabase.from('market_prices').insert(batchToInsert);
        if (error) throw error;
        totalInserted += batchToInsert.length;
        stream.resume(); // Resume parsing after successful insert
      } catch (err) {
        hasError = true;
        console.error('CSV Batch Insert Error:', err.message);
        stream.destroy();
        fs.unlinkSync(req.file.path); // Cleanup temp file
        return res.status(500).json({ success: false, error: 'Database insertion failed: ' + err.message });
      }
    }
  });

  stream.on('end', async () => {
    if (hasError) return; // Prevent double response if stream aborted

    if (results.length > 0) {
      try {
        const { error } = await supabase.from('market_prices').insert(results);
        if (error) throw error;
        totalInserted += results.length;
      } catch (err) {
        console.error('CSV Final Batch Insert Error:', err.message);
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ success: false, error: 'Database insertion failed: ' + err.message });
      }
    }

    // Cleanup local temp file
    fs.unlinkSync(req.file.path);
    res.status(200).json({ success: true, message: `${totalInserted} prices stream-uploaded successfully!` });
  });

  stream.on('error', (err) => {
    console.error('CSV Stream Read Error:', err.message);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to read CSV file.' });
    }
  });
});

app.post('/api/admin/prices/bulk', authenticateToken, async (req, res) => {
  try {
    const { prices } = req.body;
    if (!prices || !Array.isArray(prices) || prices.length === 0) throw new Error('No valid price data found.');
    const { data, error } = await supabase.from('market_prices').insert(prices).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: `${data.length} prices uploaded successfully!`, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CLEAR ALL MARKET PRICES (MUST BE HERE)
// ==========================================
app.delete('/api/admin/prices', authenticateToken, async (req, res) => {
  try {
    const { error } = await supabase.from('market_prices').delete().not('id', 'is', null);
    if (error) throw error;
    res.status(200).json({ success: true, message: 'All market prices cleared successfully!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ERROR HANDLING MIDDLEWARE
// ==========================================
app.use((err, req, res, next) => {
  // Catch invalid JSON syntax errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON Syntax:', err.message);
    return res.status(400).json({ success: false, error: 'Invalid JSON payload format.' });
  }

  // Catch payload too large errors (e.g., from express.json limit)
  if (err.type === 'entity.too.large') {
    console.error('Payload Too Large:', err.message);
    return res.status(413).json({ success: false, error: 'Payload size exceeds the 500MB limit.' });
  }

  // Generic fallback for other errors
  console.error('Unhandled Server Error:', err);
  res.status(err.status || 500).json({ success: false, error: err.message || 'Internal Server Error' });
});

// ============================================================
// BANK ONBOARDING & PAYOUT ROUTES (razorpay)
// ============================================================
const randomPennyPaise = () => Math.floor(Math.random() * 50) + 50; 

const razorpayFetch = async (path, method = 'GET', body = null) => {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const url = `https://api.razorpay.com/v1${path}`;
  
  console.log(`[RAZORPAY] ${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json().catch(() => null);
  
  if (!res.ok) {
    const errorDesc = data?.error?.description || data?.message || res.statusText;
    console.error(`[RAZORPAY_ERROR] ${res.status} ${url}:`, data);
    throw new Error(`Razorpay Error (${res.status}): ${errorDesc}`);
  }
  return data;
};

app.post('/api/bank/initiate-penny-drop', authenticateToken, async (req, res) => {
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    const { account_holder_name, account_number, ifsc_code, upi_id, account_type, bank_id } = req.body;
    const userId = req.user.id;

    // ── DEV MODE: skip real payout, use fixed ₹1.00 ──────────────
    if (isDev) {
      const referenceId = `penny_dev_${userId.slice(0, 8)}_${Date.now()}`;
      const fixedPaise = 100; // always ₹1.00 in dev

      const hash = crypto
        .createHmac('sha256', process.env.PENNY_HASH_SECRET || 'krishisethu-secret')
        .update(`${referenceId}:${fixedPaise}`)
        .digest('hex');

      await supabase.from('bank_account_verifications').insert({
        user_id: userId,
        reference_id: referenceId,
        amount_hash: hash,
        account_holder_name,
        account_number: account_number || null,
        ifsc_code: ifsc_code || null,
        upi_id: upi_id || null,
        account_type: account_type || 'savings',
        bank_id,
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      });

      return res.json({
        success: true,
        reference_id: referenceId,
        message: '[DEV] Enter ₹1.00 to proceed. No real money was sent.',
      });
    }

    // ── PRODUCTION: real RazorpayX payout ────────────────────────
    const useUPI = !!upi_id;
    const amountPaise = randomPennyPaise();
    const referenceId = `penny_${userId.replace(/-/g, '').slice(0, 12)}_${Date.now()}`;

    const { data: user, error: userErr } = await supabase.from('users').select('full_name, phone, email').eq('id', userId).single();
    if (userErr) throw new Error('User not found');

    let contactId;
    const { data: existingBank } = await supabase.from('bank_accounts').select('razorpay_contact_id').eq('user_id', userId).maybeSingle();
    if (existingBank?.razorpay_contact_id) {
      contactId = existingBank.razorpay_contact_id;
    } else {
      const contact = await razorpayFetch('/contacts', 'POST', {
        name: account_holder_name, email: user.email || undefined, contact: user.phone, type: 'vendor', reference_id: userId,
      });
      contactId = contact.id;
    }

    const fundPayload = {
      contact_id: contactId, account_type: 'bank_account',
      ...(useUPI ? { vpa: { address: upi_id } } : { bank_account: { name: account_holder_name, ifsc: ifsc_code, account_number } }),
    };
    const fundAccount = await razorpayFetch('/fund_accounts', 'POST', fundPayload);

    // ── Step C: Send penny via RazorpayX Payout
    const rxAccountNumber = process.env.RAZORPAY_X_ACCOUNT_NUMBER;
    if (!rxAccountNumber || rxAccountNumber.includes('replace_with')) {
      throw new Error('RAZORPAY_X_ACCOUNT_NUMBER is required for production payouts.');
    }

    const payout = await razorpayFetch('/payouts', 'POST', {
      account_number: rxAccountNumber,
      fund_account_id: fundAccount.id,
      amount: amountPaise,
      currency: 'INR',
      mode: useUPI ? 'UPI' : 'IMPS',
      purpose: 'verification',
      queue_if_low_balance: true,
      reference_id: referenceId,
      narration: 'KrishiSethu account verification',
    });

    const hash = crypto.createHmac('sha256', process.env.PENNY_HASH_SECRET || 'krishisethu-secret').update(`${referenceId}:${amountPaise}`).digest('hex');
    await supabase.from('bank_account_verifications').insert({
      user_id: userId, reference_id: referenceId, razorpay_contact_id: contactId, razorpay_fund_account_id: fundAccount.id,
      razorpay_payout_id: payout.id, amount_hash: hash, account_holder_name, account_number, ifsc_code, upi_id,
      account_type: account_type || 'savings', bank_id, status: 'pending', expires_at: new Date(Date.now() + 30 * 60 * 1000),
    });

    res.json({ success: true, reference_id: referenceId, message: `Sent ₹${(amountPaise / 100).toFixed(2)} to your account. Check your bank SMS.` });
  } catch (err) {
    console.error('Penny drop error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bank/verify-penny-drop', authenticateToken, async (req, res) => {
  try {
    const { reference_id, entered_amount } = req.body;
    const userId = req.user.id;
    const enteredPaise = Math.round(parseFloat(entered_amount) * 100);
    const { data: verification, error } = await supabase.from('bank_account_verifications').select('*').eq('reference_id', reference_id).eq('user_id', userId).eq('status', 'pending').single();
    if (error || !verification) throw new Error('Verification session not found or expired.');
    if (new Date() > new Date(verification.expires_at)) throw new Error('Verification window expired. Please start again.');
    const expectedHash = crypto.createHmac('sha256', process.env.PENNY_HASH_SECRET || 'krishisethu-secret').update(`${reference_id}:${enteredPaise}`).digest('hex');
    if (expectedHash !== verification.amount_hash) {
      await supabase.from('bank_account_verifications').update({ attempts: (verification.attempts || 0) + 1 }).eq('reference_id', reference_id);
      throw new Error(`Amount did not match.`);
    }
    await supabase.from('bank_account_verifications').update({ status: 'amount_verified' }).eq('reference_id', reference_id);
    res.json({ success: true, message: 'Amount verified! Proceed to card security check.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bank/register-with-card', authenticateToken, async (req, res) => {
  try {
    const { reference_id, card_last6, card_expiry_month, card_expiry_year } = req.body;
    const userId = req.user.id;
    const { data: verification, error } = await supabase.from('bank_account_verifications').select('*').eq('reference_id', reference_id).eq('user_id', userId).eq('status', 'amount_verified').single();
    if (error || !verification) throw new Error('Please complete penny drop verification first.');
    const { data: user } = await supabase.from('users').select('role, full_name, email, phone').eq('id', userId).single();
    let linkedAccountId = null;
    if (user.role === 'farmer' || user.role === 'trader') {
      const linkedAccount = await razorpayFetch('/beta/accounts', 'POST', {
        email: user.email, profile: { category: 'agriculture', subcategory: user.role === 'farmer' ? 'farmer' : 'trade', addresses: { registered: { street1: 'India', city: 'India', state: 'KA', postal_code: '560001', country: 'IN' } } },
        legal_business_name: user.full_name, business_type: 'individual', legal_info: { pan: 'AABCU9603R' }, contact_name: user.full_name, contact_info: { phone: { primary: user.phone } },
        bank_account: { name: verification.account_holder_name, account_number: verification.account_number, beneficiary_email: user.email, ifsc: verification.ifsc_code },
      }).catch(() => ({ id: null }));
      linkedAccountId = linkedAccount.id;
    }
    const { data: bankAccount, error: saveErr } = await supabase.from('bank_accounts').upsert({
      user_id: userId, account_holder_name: verification.account_holder_name, account_number: verification.account_number, ifsc_code: verification.ifsc_code, upi_id: verification.upi_id,
      account_type: verification.account_type, bank_id: verification.bank_id, card_last6, card_expiry_month, card_expiry_year, razorpay_contact_id: verification.razorpay_contact_id,
      razorpay_fund_account_id: verification.razorpay_fund_account_id, razorpay_linked_account_id: linkedAccountId, is_verified: true, updated_at: new Date(),
    }, { onConflict: 'user_id' }).select().single();
    if (saveErr) throw saveErr;
    await supabase.from('bank_account_verifications').update({ status: 'completed' }).eq('reference_id', reference_id);
    res.json({ success: true, message: 'Bank account registered successfully!', linked_account_id: linkedAccountId, bank_account_id: bankAccount.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bank/my-account', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('bank_accounts').select('*').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ has_account: false });
    const masked = data.account_number ? '*'.repeat(data.account_number.length - 4) + data.account_number.slice(-4) : null;
    res.json({ has_account: true, ...data, account_number: masked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MANDI PRICE FEED ROUTES (AGMARKNET)
// ============================================================
const mandiCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; 
const DATA_GOV_BASE = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070';

const fetchAgmarknet = async ({ state, commodity, limit = 100 }) => {
  const apiKey = process.env.DATA_GOV_API_KEY;
  if (!apiKey) throw new Error('DATA_GOV_API_KEY is missing');
  const params = new URLSearchParams({ 'api-key': apiKey, 'format': 'json', 'limit': String(limit), 'offset': '0' });
  if (state) params.append('filters[state]', state);
  if (commodity) params.append('filters[commodity]', commodity);
  const res = await fetch(`${DATA_GOV_BASE}?${params.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`data.gov.in API error: ${res.status}`);
  const json = await res.json();
  return json.records || [];
};

app.get('/api/mandi/prices', authenticateToken, async (req, res) => {
  try {
    const { state = 'Karnataka', commodity } = req.query;
    const cacheKey = `${state}:${commodity || 'all'}`;
    const cached = mandiCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return res.json({ success: true, data: cached.data });

    const raw = await fetchAgmarknet({ state, commodity, limit: 150 });
    const records = raw.map((r, i) => ({
      id: `${r.commodity}-${r.market}-${r.arrival_date}-${i}`, state: r.state, market: r.market, commodity: r.commodity,
      variety: r.variety || r.commodity, arrival_date: r.arrival_date, min_price: parseFloat(r.min_price), max_price: parseFloat(r.max_price), modal_price: parseFloat(r.modal_price),
    }));
    mandiCache.set(cacheKey, { data: records, fetchedAt: Date.now() });
    res.json({ success: true, data: records });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/mandi/prices/top', authenticateToken, async (req, res) => {
  try {
    const { commodity, limit = 10 } = req.query;
    if (!commodity) return res.status(400).json({ error: 'commodity is required' });
    const raw = await fetchAgmarknet({ commodity, limit: 200 });
    const records = raw.map((r, i) => ({
      id: `${r.commodity}-${r.market}-${r.arrival_date}-${i}`, state: r.state, market: r.market, commodity: r.commodity, modal_price: parseFloat(r.modal_price),
    })).sort((a, b) => b.modal_price - a.modal_price).slice(0, parseInt(limit));
    res.json({ success: true, data: records });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const port = parseInt(process.env.PORT, 10) || 10000;
const server = app.listen(port, () => console.log(`🚀 Server running on port ${port} [${process.env.NODE_ENV || 'development'} mode]`));

// 💬 WebSocket chat rooms — /ws?order_id=<id>&token=<jwt>
// Broadcasts messages to all clients in the same order room
app.ws('/ws', async (ws, req) => {
  const { order_id, user_id, token } = req.query;

  if (!token) {
    ws.close(1008, 'Token required');
    return;
  }

  // Validate the JWT token
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const authenticatedUserId = data.user.id;

  // CASE 1: Chat Room (order_id provided)
  if (order_id) {
    console.log(`🔗 WS: User ${authenticatedUserId} joined CHAT room ${order_id}`);
    if (!chatRooms[order_id]) chatRooms[order_id] = new Set();
    chatRooms[order_id].add(ws);

    ws.on('message', (msg) => {
      chatRooms[order_id]?.forEach(client => {
        if (client !== ws && client.readyState === 1) client.send(msg);
      });
    });

    ws.on('close', () => {
      chatRooms[order_id]?.delete(ws);
      if (chatRooms[order_id]?.size === 0) delete chatRooms[order_id];
    });
  }

  // CASE 2: Global Notifications (user_id provided)
  else if (user_id) {
    // Basic validation: User can only subscribe to their own notification stream
    if (user_id !== authenticatedUserId) {
      ws.close(1008, 'Forbidden: Cannot subscribe to another user\'s stream');
      return;
    }

    console.log(`📡 WS: User ${authenticatedUserId} joined NOTIFICATION stream`);

    // Global connections map for notifications
    if (!globalConnections) globalConnections = new Map();
    globalConnections.set(authenticatedUserId, ws);

    ws.on('close', () => {
      globalConnections.delete(authenticatedUserId);
      console.log(`🔌 WS: User ${authenticatedUserId} left notification stream`);
    });
  }

  ws.on('error', (err) => {
    console.error(`WS error for user ${authenticatedUserId}:`, err);
  });
});

// ── Admin auth middleware ─────────────────────────────────────
const requireAdmin = async (req, res, next) => {
  try {
    const { data: user } = await supabase
      .from('users').select('role').eq('id', req.user.id).single();
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch { res.status(403).json({ error: 'Forbidden' }); }
};

// GET /api/admin/stats — Overview tab
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [
      { count: totalFarmers },
      { count: totalTraders },
      { data: orderStats },
      { data: gmvStats },
      { count: pendingKycCountVal },
      { count: pendingLegacyKycCountVal },
      { count: openDisputesVal },
      { count: pendingPayoutsVal },
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'farmer'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'trader'),
      supabase.from('orders').select('status, final_amount'),
      supabase.from('orders').select('final_amount').in('status', ['completed', 'paid']),
      supabase.from('farmer_kyc').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('users').select('*', { count: 'exact', head: true }).or('verification_status.eq.pending_verification,verification_status.eq.unverified'),
      supabase.from('order_disputes').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('payment_status', ['kyc_pending', 'bank_pending', 'failed', 'yet_to_paid', 'not_paid']),
    ]);

    const totalKycPending = (pendingKycCountVal || 0) + (pendingLegacyKycCountVal || 0);
    console.log(`[ADMIN_STATS] Pending KYC: ${totalKycPending} (New: ${pendingKycCountVal}, Legacy: ${pendingLegacyKycCountVal})`);
    console.log(`[ADMIN_STATS] Payouts: ${pendingPayoutsVal}, Disputes: ${openDisputesVal}`);

    const allOrders = orderStats || [];
    const activeStatuses = ['placed', 'confirmed', 'dispatched', 'delivered'];
    const totalGmv = (gmvStats || []).reduce((s, o) => s + (o.final_amount || 0), 0);
    const platformRevenue = totalGmv * 0.03;
    const avgOrderValue = gmvStats?.length ? totalGmv / gmvStats.length : 0;

    res.json({
      success: true,
      data: {
        total_farmers: totalFarmers || 0,
        total_traders: totalTraders || 0,
        total_orders: allOrders.length,
        active_orders: allOrders.filter(o => activeStatuses.includes(o.status)).length,
        total_gmv: totalGmv,
        platform_revenue: platformRevenue,
        avg_order_value: avgOrderValue,
        pending_kyc: totalKycPending,
        open_disputes: openDisputesVal || 0,
        pending_payouts: pendingPayoutsVal || 0,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: {} });
  }
});

// GET /api/admin/kyc — KYC tab
app.get('/api/admin/kyc', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { data, error } = await supabase
      .from('farmer_kyc')
      .select(`
        id, user_id, pan_number, pan_name, pan_dob,
        aadhaar_last4, aadhaar_name, aadhaar_address,
        selfie_path, aadhaar_doc_path, face_match_score,
        status, submitted_at, rejection_reason,
        user:users!user_id(full_name, phone, email)
      `)
      .eq('status', status)
      .order('submitted_at', { ascending: true })
      .limit(100);

    if (error) throw error;

    // Merge with legacy users
    let records = [];
    if (status === 'approved') {
      const { data: legacy } = await supabase
        .from('users')
        .select('id, full_name, phone, email, document_url, updated_at')
        .eq('verification_status', 'verified');
      
      records = (legacy || []).map(u => ({
        id: `legacy-${u.id}`, user_id: u.id, status: 'approved', submitted_at: u.updated_at,
        user_name: u.full_name, user_phone: u.phone, user_email: u.email,
        selfie_url: u.document_url,
      }));
    } else if (status === 'pending') {
      const { data: legacy } = await supabase
        .from('users')
        .select('id, full_name, phone, email, document_url, updated_at')
        .or('verification_status.eq.pending_verification,verification_status.eq.unverified');
      
      records = (legacy || []).map(u => ({
        id: `legacy-${u.id}`, user_id: u.id, status: 'pending', submitted_at: u.updated_at,
        user_name: u.full_name, user_phone: u.phone, user_email: u.email,
        selfie_url: u.document_url,
      }));
    } else if (status === 'rejected') {
      const { data: legacy } = await supabase
        .from('users')
        .select('id, full_name, phone, email, document_url, updated_at')
        .eq('verification_status', 'rejected');
      
      records = (legacy || []).map(u => ({
        id: `legacy-${u.id}`, user_id: u.id, status: 'rejected', submitted_at: u.updated_at,
        user_name: u.full_name, user_phone: u.phone, user_email: u.email,
        selfie_url: u.document_url,
      }));
    }

    const newRecords = await Promise.all((data || []).map(async k => {
      let selfieUrl = null, docUrl = null;
      if (k.selfie_path) {
        const { data: u } = await supabase.storage.from('kyc-documents').createSignedUrl(k.selfie_path, 3600);
        selfieUrl = u?.signedUrl;
      }
      if (k.aadhaar_doc_path) {
        const { data: u } = await supabase.storage.from('kyc-documents').createSignedUrl(k.aadhaar_doc_path, 3600);
        docUrl = u?.signedUrl;
      }
      return {
        ...k,
        user_name: k.user?.full_name,
        user_phone: k.user?.phone,
        user_email: k.user?.email,
        selfie_url: selfieUrl,
        aadhaar_doc_url: docUrl,
      };
    }));

    records = [...records, ...newRecords];
    console.log(`[ADMIN_KYC] Fetching status=${status}. Found ${records.length} records (${newRecords.length} new, ${records.length - newRecords.length} legacy)`);
    res.json({ success: true, data: records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// POST /api/admin/kyc/:userId/decision
app.post('/api/admin/kyc/:userId/decision', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, reason } = req.body;
    const targetId = req.params.userId;

    if (!['approved', 'rejected'].includes(decision))
      return res.status(400).json({ error: 'Invalid decision' });

    // Check if this is a legacy user (if no farmer_kyc record exists)
    const { data: kycRecord } = await supabase.from('farmer_kyc').select('id').eq('user_id', targetId).maybeSingle();

    if (kycRecord) {
      await supabase.from('farmer_kyc').update({
        status: decision,
        rejection_reason: decision === 'rejected' ? (reason || 'Documents did not meet requirements') : null,
        reviewed_by: req.user.id,
        verified_at: decision === 'approved' ? new Date() : null,
        updated_at: new Date(),
      }).eq('user_id', targetId);
    }

    // Always update the base user record
    await supabase.from('users').update({
      kyc_verified: decision === 'approved',
      verification_status: decision === 'approved' ? 'verified' : 'rejected',
      updated_at: new Date(),
    }).eq('id', targetId);

    // SMS notification
    const { data: farmer } = await supabase.from('users').select('phone').eq('id', targetId).single();
    if (farmer?.phone) {
      const msg = decision === 'approved'
        ? `KrishiSethu: Badhai ho! Aapka KYC approved ho gaya. Ab aap fasal bech sakte hain.`
        : `KrishiSethu: Aapka KYC rejected hua. Reason: ${reason || 'Documents incomplete'}.`;
      await sendSMS(farmer.phone, msg);
    }

    res.json({ success: true, decision });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/users?search=&role=all|farmer|trader
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search = '', role = 'all' } = req.query;

    let query = supabase
      .from('users')
      .select('id, full_name, phone, email, role, kyc_verified, location, business_name, created_at, status');

    if (role !== 'all') query = query.eq('role', role);
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    const { data: users, error } = await query.order('created_at', { ascending: false }).limit(200);
    if (error) throw error;

    // Enrich with order stats per user
    const enriched = await Promise.all((users || []).map(async (u) => {
      const isfarmer = u.role === 'farmer';
      const col = isfarmer ? 'farmer_id' : 'trader_id';

      const [{ data: orders }, { data: ratings }] = await Promise.all([
        supabase.from('orders').select('id, final_amount, status').eq(col, u.id),
        supabase.from('order_ratings').select('rating').eq('ratee_id', u.id),
      ]);

      const totalOrders = orders?.length || 0;
      const totalGmv = (orders || []).reduce((s, o) => s + (o.final_amount || 0), 0);
      const ratingsArr = (ratings || []).map(r => r.rating);
      const avgRating = ratingsArr.length > 0
        ? Math.round((ratingsArr.reduce((s, r) => s + r, 0) / ratingsArr.length) * 10) / 10
        : 0;

      // Determine status: check if suspended in a meta column, default active
      const status = u.status || 'active';

      return {
        id: u.id,
        full_name: u.full_name,
        phone: u.phone,
        email: u.email,
        role: u.role,
        kyc_verified: !!u.kyc_verified,
        status,
        total_orders: totalOrders,
        total_gmv: totalGmv,
        avg_rating: avgRating,
        rating_count: ratingsArr.length,
        village: isfarmer ? u.location : null,
        city: !isfarmer ? (u.business_name || u.location) : null,
        joined_at: u.created_at,
      };
    }));

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// PATCH /api/admin/users/:id/status — suspend or reactivate
app.patch('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    // Store status in users table (add column if missing, gracefully handle)
    const { error } = await supabase.from('users').update({ status }).eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/payouts?status=all|failed|kyc_pending|bank_pending
app.get('/api/admin/payouts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        id, final_amount, payment_status, created_at, razorpay_payment_id, farmer_id,
        farmer:users!farmer_id(full_name, phone),
        trader:users!trader_id(full_name, phone),
        listing:crop_listings!listing_id(variety)
      `)
      .in('payment_status', ['failed', 'kyc_pending', 'bank_pending', 'processing', 'yet_to_paid', 'not_paid']);

    if (status !== 'all') query = query.eq('payment_status', status);

    const { data, error } = await query.order('created_at', { ascending: true }).limit(100);
    if (error) throw error;

    // Fetch bank accounts for all farmers in this batch
    const farmerIds = [...new Set((data || []).map(o => o.farmer_id))];
    const { data: banks } = await supabase
      .from('bank_accounts')
      .select('user_id, bank_id, account_number')
      .in('user_id', farmerIds);

    const bankMap = (banks || []).reduce((acc, b) => {
      acc[b.user_id] = b;
      return acc;
    }, {});

    const result = (data || []).map(o => {
      const bank = bankMap[o.farmer_id];
      return {
        id: o.id,
        order_id: o.id,
        farmer_name: o.farmer?.full_name || 'Unknown',
        farmer_phone: o.farmer?.phone || '',
        trader_name: o.trader?.full_name || 'System / Direct',
        trader_phone: o.trader?.phone || '',
        crop_name: o.listing?.variety || 'Unknown Crop',
        final_amount: o.final_amount || 0,
        payout_amount: Math.round((o.final_amount || 0) * 0.97 * 100) / 100,
        status: o.payment_status,
        razorpay_payment_id: o.razorpay_payment_id || null,
        bank_name: bank?.bank_id || null, // Mapping bank_id to bank_name for frontend display
        account_number: bank?.account_number || null,
        created_at: o.created_at,
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// POST /api/admin/payouts/:orderId/pay — manual trigger
app.post('/api/admin/payouts/:orderId/pay', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    // 1. Fetch order details
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, payment_status, final_amount, farmer_id')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });

    // 2. Prevent double payment if already paid
    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'This order has already been paid' });
    }

    // 3. Update status to 'paid' (In a real app, this would trigger RazorpayX / Payout API)
    const { error: updateErr } = await supabase
      .from('orders')
      .update({ 
        payment_status: 'paid',
        status: 'completed', // Finalize order status too
        updated_at: new Date()
      })
      .eq('id', orderId);

    if (updateErr) throw updateErr;

    console.log(`💰 [ADMIN] Manual payout triggered for order ${orderId} by admin ${req.user.id}`);

    res.json({ success: true, message: 'Payout marked as successful' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/disputes — Disputes tab
app.get('/api/admin/disputes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;

    let query = supabase
      .from('order_disputes')
      .select(`
        id, order_id, reason, details, status, created_at,
        order:orders!order_id (
          final_amount,
          listing:crop_listings!listing_id(variety),
          farmer:users!farmer_id(full_name, phone),
          trader:users!trader_id(full_name, phone)
        )
      `)
      .order('created_at', { ascending: false });

    if (status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || []).map(d => ({
      id: d.id,
      order_id: d.order_id,
      status: d.status,
      reason: d.reason,
      details: d.details,
      created_at: d.created_at,
      crop_name: d.order?.listing?.variety || 'Unknown',
      final_amount: d.order?.final_amount || 0,
      farmer_name: d.order?.farmer?.full_name || 'System',
      farmer_phone: d.order?.farmer?.phone || '',
      trader_name: d.order?.trader?.full_name || 'System',
      trader_phone: d.order?.trader?.phone || '',
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// POST /api/admin/disputes/:disputeId/resolve
app.post('/api/admin/disputes/:disputeId/resolve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { decision, resolution } = req.body;

    if (!['farmer', 'trader', 'split'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }

    // 1. Update dispute record
    const { error: disputeErr } = await supabase
      .from('order_disputes')
      .update({
        status: 'resolved',
        resolution,
        resolved_by: req.user.id,
        resolved_at: new Date()
      })
      .eq('id', disputeId);

    if (disputeErr) throw disputeErr;
    
    console.log(`⚖️ [ADMIN] Dispute ${disputeId} resolved as ${decision} by ${req.user.id}`);

    res.json({ success: true, message: 'Dispute resolved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/orders — used by adminGetDashboard
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, status, payment_status, final_amount, created_at, farmer_id, trader_id')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});


// ==========================================
// RATINGS & REVIEWS
// ==========================================

// POST /api/orders/:id/rating — submit a rating after delivery
app.post('/api/orders/:id/rating', authenticateToken, async (req, res) => {
  try {
    const orderId = req.params.id;
    const raterId = req.user.id;
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });

    // Fetch order to verify participation and status
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('farmer_id, trader_id, status')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) return res.status(404).json({ error: 'Order not found' });

    const isFarmer = raterId === order.farmer_id;
    const isTrader = raterId === order.trader_id;
    if (!isFarmer && !isTrader)
      return res.status(403).json({ error: 'Not a participant of this order' });

    if (!['delivered', 'completed', 'paid'].includes(order.status))
      return res.status(400).json({ error: 'Can only rate after order is delivered' });

    const rateeId = isFarmer ? order.trader_id : order.farmer_id;
    const role = isFarmer ? 'farmer' : 'trader';

    const { data, error } = await supabase
      .from('order_ratings')
      .upsert([{ order_id: orderId, rater_id: raterId, ratee_id: rateeId, role, rating, comment }],
        { onConflict: 'order_id,rater_id' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id/rating — get avg rating + recent reviews for a profile
app.get('/api/users/:id/rating', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.id;

    const { data: ratings, error } = await supabase
      .from('order_ratings')
      .select('rating, comment, role, created_at, rater:users!rater_id(full_name)')
      .eq('ratee_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const count = ratings?.length || 0;
    const avg = count > 0
      ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10
      : null;

    res.json({
      success: true,
      avg_rating: avg,
      total_ratings: count,
      reviews: (ratings || []).map(r => ({
        rating: r.rating,
        comment: r.comment,
        role: r.role,
        reviewer_name: r.rater?.full_name || 'Anonymous',
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});