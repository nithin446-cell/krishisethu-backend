const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const FormData = require('form-data');
const axios = require('axios');
// Load env based on NODE_ENV: .env.production in prod, .env.development in dev
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: `${__dirname}/${envFile}` });
// Fallback to plain .env if specific file doesn't exist
dotenv.config({ path: `${__dirname}/.env` });

const app = express();
app.use(cors());

// 🔌 Initialize express-ws for WebSocket support (chat rooms)
const expressWs = require('express-ws')(app);
const chatRooms = {}; // { order_id: Set<WebSocket> }

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
    const { data, error } = await req.userSupabase
      .from('orders')
      .select(`
        *,
        crop_listings(variety, unit, crop_name),
        farmer:users!farmer_id(full_name, phone, location),
        trader:users!trader_id(full_name, phone, location, business_name)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !data) throw new Error(error?.message || 'Order not found');
    
    // Format data to match what OrderTracking.tsx expects
    const formattedData = {
      ...data,
      crop_name: data.crop_listings?.crop_name || data.crop_listings?.variety || 'Unknown Crop',
      unit: data.crop_listings?.unit || 'kg',
      farmer_name: data.farmer?.full_name || 'Farmer',
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
      payout_reference: payoutResult?.id || null, // Might be null if fallback Option C
      farmer_confirmed_at: new Date(),
      updated_at: new Date(),
    }).eq('id', orderId);

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
    // All 4 operations (accept bid, reject others, mark sold, create order) run in one DB transaction
    const { error } = await req.userSupabase.rpc('accept_bid', {
      p_bid_id: req.params.id,
      p_listing_id: listing_id
    });
    if (error) throw error;
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


// ==========================================
// ADMIN PORTAL ENDPOINTS
// ==========================================
// ── Admin auth middleware ─────────────────────────────────────
const requireAdmin = async (req, res, next) => {
  try {
    const { data: user } = await supabase
      .from('users').select('role').eq('id', req.user.id).single();
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch { res.status(403).json({ error: 'Forbidden' }); }
};

// ============================================================
// ROUTE 1: Platform stats
// GET /api/admin/stats
// ============================================================
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [
      { count: totalFarmers },
      { count: totalTraders },
      { data: orderStats },
      { data: gmvStats },
      { count: pendingKyc },
      { count: openDisputes },
      { count: pendingPayouts },
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'farmer'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'trader'),
      supabase.from('orders').select('status, final_amount'),
      supabase.from('orders').select('final_amount').eq('status', 'paid'),
      supabase.from('farmer_kyc').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('order_disputes').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('orders').select('*', { count: 'exact', head: true })
        .in('payment_status', ['kyc_pending', 'bank_pending', 'failed']),
    ]);

    const allOrders = orderStats || [];
    const activeStatuses = ['placed','confirmed','dispatched','delivered'];
    const totalGmv = (gmvStats || []).reduce((s, o) => s + (o.final_amount || 0), 0);
    const platformRevenue = totalGmv * 0.03;
    const avgOrderValue = gmvStats?.length ? totalGmv / gmvStats.length : 0;

    res.json({
      total_farmers: totalFarmers || 0,
      total_traders: totalTraders || 0,
      total_orders: allOrders.length,
      active_orders: allOrders.filter(o => activeStatuses.includes(o.status)).length,
      total_gmv: totalGmv,
      platform_revenue: platformRevenue,
      avg_order_value: avgOrderValue,
      pending_kyc: pendingKyc || 0,
      open_disputes: openDisputes || 0,
      pending_payouts: pendingPayouts || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 2: KYC list
// GET /api/admin/kyc?status=pending|approved|rejected
// ============================================================
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

    // Generate signed URLs for private KYC docs (valid 1 hour)
    const records = await Promise.all((data || []).map(async k => {
      let selfieUrl = null, docUrl = null;
      if (k.selfie_path) {
        const { data: u } = await supabase.storage.from('kyc-documents')
          .createSignedUrl(k.selfie_path, 3600);
        selfieUrl = u?.signedUrl;
      }
      if (k.aadhaar_doc_path) {
        const { data: u } = await supabase.storage.from('kyc-documents')
          .createSignedUrl(k.aadhaar_doc_path, 3600);
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

    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 3: KYC approve/reject
// POST /api/admin/kyc/:userId/decision
// Body: { decision: 'approved'|'rejected', reason? }
// ============================================================
app.post('/api/admin/kyc/:userId/decision', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, reason } = req.body;
    const targetId = req.params.userId;

    if (!['approved','rejected'].includes(decision))
      return res.status(400).json({ error: 'Invalid decision' });

    await supabase.from('farmer_kyc').update({
      status: decision,
      rejection_reason: decision === 'rejected' ? (reason || 'Documents did not meet requirements') : null,
      reviewed_by: req.user.id,
      verified_at: decision === 'approved' ? new Date() : null,
      updated_at: new Date(),
    }).eq('user_id', targetId);

    if (decision === 'approved') {
      await supabase.from('users').update({ kyc_verified: true }).eq('id', targetId);

      // Update Razorpay Route linked account with verified PAN
      const { data: kyc } = await supabase.from('farmer_kyc')
        .select('pan_number').eq('user_id', targetId).single();
      const { data: bank } = await supabase.from('bank_accounts')
        .select('razorpay_linked_account_id').eq('user_id', targetId).maybeSingle();

      if (kyc?.pan_number && bank?.razorpay_linked_account_id) {
        await razorpayFetch(`/beta/accounts/${bank.razorpay_linked_account_id}`, 'PATCH', {
          legal_info: { pan: kyc.pan_number }
        }).catch(e => console.warn('Razorpay KYC update:', e.message));
      }

      // Release any orders that were stuck on kyc_pending
      const { data: stuck } = await supabase.from('orders')
        .select('id, final_amount, farmer_fund_account_id, razorpay_order_id')
        .eq('farmer_id', targetId).eq('payment_status', 'kyc_pending');

      for (const order of stuck || []) {
        // Re-trigger payout — reuse confirm-payment logic
        try {
          const paise = Math.round(order.final_amount * 97);
          if (order.farmer_fund_account_id) {
            await razorpayFetch('/payouts', 'POST', {
              account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
              fund_account_id: order.farmer_fund_account_id,
              amount: paise, currency: 'INR', mode: 'IMPS',
              purpose: 'payout', queue_if_low_balance: true,
              reference_id: order.id,
              narration: `KrishiSethu order ${order.id.slice(0,8)}`,
            });
            await supabase.from('orders').update({
              payment_status: 'paid', paid_at: new Date(), status: 'paid'
            }).eq('id', order.id);
          }
        } catch (payErr) {
          console.warn('Post-KYC payout failed for order', order.id, payErr.message);
        }
      }
    }

    // TODO: Send SMS to farmer with KYC result

    res.json({ success: true, decision });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 4: Disputes list
// GET /api/admin/disputes?status=open|resolved|closed
// ============================================================
app.get('/api/admin/disputes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const { data, error } = await supabase
      .from('order_disputes')
      .select(`
        id, order_id, reason, details, status, resolution, created_at,
        raiser:users!raised_by(full_name),
        order:orders!order_id(
          final_amount,
          listing:listings!listing_id(crop_name),
          farmer:users!farmer_id(full_name, phone),
          trader:users!trader_id(full_name, phone)
        )
      `)
      .eq('status', status)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json((data || []).map(d => ({
      id: d.id,
      order_id: d.order_id,
      reason: d.reason,
      details: d.details,
      status: d.status,
      resolution: d.resolution,
      created_at: d.created_at,
      raised_by_name: d.raiser?.full_name,
      crop_name: d.order?.listing?.crop_name,
      final_amount: d.order?.final_amount,
      farmer_name: d.order?.farmer?.full_name,
      farmer_phone: d.order?.farmer?.phone,
      trader_name: d.order?.trader?.full_name,
      trader_phone: d.order?.trader?.phone,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 5: Resolve dispute
// POST /api/admin/disputes/:id/resolve
// Body: { decision: 'farmer'|'trader'|'split', resolution }
// ============================================================
app.post('/api/admin/disputes/:id/resolve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, resolution } = req.body;
    const disputeId = req.params.id;

    const { data: dispute } = await supabase
      .from('order_disputes').select('order_id').eq('id', disputeId).single();
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

    // Update dispute record
    await supabase.from('order_disputes').update({
      status: 'resolved',
      resolution: `[${decision.toUpperCase()}] ${resolution}`,
      resolved_by: req.user.id,
      resolved_at: new Date(),
    }).eq('id', disputeId);

    // Update order status
    const newOrderStatus = decision === 'farmer' ? 'cancelled' : 'paid';
    await supabase.from('orders').update({
      status: newOrderStatus,
      updated_at: new Date(),
    }).eq('id', dispute.order_id);

    // If in favour of farmer — handle refund to trader (manual)
    // If in favour of trader — release payment to farmer
    if (decision === 'trader') {
      // Attempt payout — same logic as confirm-payment
      const { data: order } = await supabase.from('orders')
        .select('*, bank_accounts!farmer_id(razorpay_fund_account_id, razorpay_linked_account_id)')
        .eq('id', dispute.order_id).single();

      const fundAccId = order?.bank_accounts?.razorpay_fund_account_id;
      if (fundAccId) {
        await razorpayFetch('/payouts', 'POST', {
          account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
          fund_account_id: fundAccId,
          amount: Math.round(order.final_amount * 97),
          currency: 'INR', mode: 'IMPS', purpose: 'payout',
          queue_if_low_balance: true,
          reference_id: dispute.order_id,
          narration: `Dispute resolved: KrishiSethu ${dispute.order_id.slice(0,8)}`,
        }).catch(e => console.warn('Dispute payout failed:', e.message));
      }
    }

    // TODO: SMS both parties with outcome

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 6: Users list
// GET /api/admin/users?search=&role=farmer|trader|all
// ============================================================
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search, role } = req.query;

    let query = supabase
      .from('users')
      .select(`
        id, full_name, phone, email, role, status, kyc_verified,
        avg_rating, rating_count, village, city, created_at
      `)
      .order('created_at', { ascending: false })
      .limit(200);

    if (role && role !== 'all') query = query.eq('role', role);
    if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);

    const { data: users, error } = await query;
    if (error) throw error;

    // Get per-user order stats
    const userIds = (users || []).map(u => u.id);
    const { data: orderData } = await supabase
      .from('orders')
      .select('farmer_id, trader_id, final_amount, status')
      .or(`farmer_id.in.(${userIds.join(',')}),trader_id.in.(${userIds.join(',')})`)
      .in('status', ['paid']);

    const statsMap = {};
    for (const o of orderData || []) {
      const fid = o.farmer_id; const tid = o.trader_id;
      if (!statsMap[fid]) statsMap[fid] = { total: 0, gmv: 0 };
      if (!statsMap[tid]) statsMap[tid] = { total: 0, gmv: 0 };
      statsMap[fid].total++; statsMap[fid].gmv += o.final_amount || 0;
      statsMap[tid].total++; statsMap[tid].gmv += o.final_amount || 0;
    }

    res.json((users || []).map(u => ({
      ...u,
      joined_at: u.created_at,
      total_orders: statsMap[u.id]?.total || 0,
      total_gmv: statsMap[u.id]?.gmv || 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 7: Update user status (suspend / reactivate)
// PATCH /api/admin/users/:id/status
// Body: { status: 'active'|'suspended' }
// ============================================================
app.patch('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','suspended'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    await supabase.from('users').update({ status, updated_at: new Date() }).eq('id', req.params.id);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 8: Stuck payouts list
// GET /api/admin/payouts?status=all|failed|kyc_pending|bank_pending
// ============================================================
app.get('/api/admin/payouts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        id, final_amount, created_at, payment_status,
        farmer:users!farmer_id(full_name, phone),
        bank:bank_accounts!farmer_id(bank_id),
        listing:listings!listing_id(crop_name)
      `)
      .order('created_at', { ascending: true });

    if (status && status !== 'all') {
      query = query.eq('payment_status', status);
    } else {
      query = query.in('payment_status', ['failed','kyc_pending','bank_pending']);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json((data || []).map(o => ({
      id: o.id,
      order_id: o.id,
      farmer_name: o.farmer?.full_name,
      farmer_phone: o.farmer?.phone,
      bank_name: o.bank?.bank_id,
      final_amount: o.final_amount,
      payout_amount: Math.round(o.final_amount * 0.97),
      status: o.payment_status,
      created_at: o.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 9: Manual payout override
// POST /api/admin/payouts/:orderId/pay
// ============================================================
app.post('/api/admin/payouts/:orderId/pay', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const orderId = req.params.orderId;

    const { data: order } = await supabase
      .from('orders')
      .select('*, bank_accounts!farmer_id(razorpay_fund_account_id, razorpay_linked_account_id, is_verified)')
      .eq('id', orderId).single();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    const bank = order.bank_accounts;
    if (!bank?.is_verified) return res.status(400).json({ error: 'Farmer has no verified bank account' });

    const farmerPaise = Math.round(order.final_amount * 97);
    let payoutResult = null;

    if (bank.razorpay_linked_account_id) {
      const transfers = await razorpayFetch(`/orders/${order.razorpay_order_id}/transfers`).catch(() => null);
      const transfer = transfers?.items?.[0];
      if (transfer?.on_hold) {
        payoutResult = await razorpayFetch(`/transfers/${transfer.id}`, 'PATCH', { on_hold: 0 });
      }
    }

    if (!payoutResult && bank.razorpay_fund_account_id) {
      payoutResult = await razorpayFetch('/payouts', 'POST', {
        account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
        fund_account_id: bank.razorpay_fund_account_id,
        amount: farmerPaise, currency: 'INR', mode: 'IMPS',
        purpose: 'payout', queue_if_low_balance: true,
        reference_id: `admin_${orderId}`,
        narration: `Admin override: KrishiSethu ${orderId.slice(0,8)}`,
      });
    }

    if (!payoutResult) return res.status(400).json({ error: 'No valid payout method found for this farmer' });

    await supabase.from('orders').update({
      payment_status: 'paid', paid_at: new Date(),
      status: 'paid', payout_reference: payoutResult.id,
      updated_at: new Date(),
    }).eq('id', orderId);

    res.json({ success: true, payout_id: payoutResult.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    const { data: orders, error } = await supabase.from('orders').select(`*, crop_listings (variety, quantity, unit), farmer:users!farmer_id (full_name, phone), trader:users!trader_id (full_name, phone)`).order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/order/:id/resolve', authenticateToken, async (req, res) => {
  try {
    const { action } = req.body; 
    let newStatus = action === 'refund_trader' ? 'cancelled' : 'completed';
    let paymentStatus = action === 'refund_trader' ? 'refunded' : 'paid';

    const { data, error } = await supabase.from('orders').update({ status: newStatus, payment_status: paymentStatus, updated_at: new Date() }).eq('id', req.params.id).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: 'Dispute resolved successfully', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/verifications', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, full_name, role, phone, email, location, business_name, verification_status, document_type, document_url, created_at').eq('verification_status', 'pending_verification').order('created_at', { ascending: false });
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/verify/:userId', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from('users').update({ verification_status: status }).eq('id', req.params.userId).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: `User marked as ${status}`, data });
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

// Load external bank routes
require('./bankRoutes')(app, supabase, authenticateToken, razorpay);

const port = parseInt(process.env.PORT, 10) || 10000;
const server = app.listen(port, () => console.log(`🚀 Server running on port ${port} [${process.env.NODE_ENV || 'development'} mode]`));

// 💬 WebSocket chat rooms — /ws?order_id=<id>&token=<jwt>
// Broadcasts messages to all clients in the same order room
app.ws('/ws', async (ws, req) => {
  const { order_id, token } = req.query;

  if (!order_id || !token) {
    ws.close(1008, 'Missing order_id or token');
    return;
  }

  // Validate the JWT token
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const userId = data.user.id;
  console.log(`🔗 WS: User ${userId} joined room ${order_id}`);

  // Add to room
  if (!chatRooms[order_id]) chatRooms[order_id] = new Set();
  chatRooms[order_id].add(ws);

  ws.on('message', (msg) => {
    // Broadcast to everyone else in the same room
    chatRooms[order_id]?.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(msg);
      }
    });
  });

  ws.on('close', () => {
    chatRooms[order_id]?.delete(ws);
    if (chatRooms[order_id]?.size === 0) delete chatRooms[order_id];
    console.log(`🔌 WS: User ${userId} left room ${order_id}`);
  });

  ws.on('error', (err) => {
    console.error(`WS error for user ${userId} in room ${order_id}:`, err);
  });
});