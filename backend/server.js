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

dotenv.config({ path: __dirname + '/.env' });

const app = express();
app.use(cors());
app.use(express.json());

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
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, full_name, role, phone, location, business_name } = req.body;
  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
    if (authError) throw authError;

    const { data: userData, error: userError } = await supabase.from('users').insert([{
      id: authData.user.id, role, full_name, phone, location, business_name
    }]).select().single();
    if (userError) throw userError;

    res.status(201).json({ success: true, message: 'Account created', user: userData, session: authData.session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

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
      id: authData.user.id, role, full_name, phone, location, business_name
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

app.put('/api/farmer/order/:id/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { payment_status } = req.body;
    let updateData = { payment_status, updated_at: new Date() };
    if (payment_status === 'paid') updateData.farmer_confirmed_at = new Date();
    else if (payment_status === 'not_paid') updateData.status = 'disputed';

    const { data, error } = await supabase.from('orders').update(updateData).eq('id', req.params.id).eq('farmer_id', req.user.id).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: `Payment marked ${payment_status}`, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/farmer/bid/:id/accept', authenticateToken, async (req, res) => {
  try {
    const { listing_id } = req.body;
    const { data: bidData } = await req.userSupabase.from('bids').select('*').eq('id', req.params.id).single();
    const { data: listingData } = await req.userSupabase.from('crop_listings').select('farmer_id').eq('id', listing_id).single();

    await req.userSupabase.from('bids').update({ status: 'accepted' }).eq('id', req.params.id);
    await req.userSupabase.from('bids').update({ status: 'rejected' }).eq('listing_id', listing_id).neq('id', req.params.id);
    await req.userSupabase.from('crop_listings').update({ status: 'sold' }).eq('id', listing_id);

    await req.userSupabase.from('orders').insert([{ listing_id, bid_id: req.params.id, farmer_id: listingData.farmer_id, trader_id: bidData.trader_id, final_amount: bidData.amount, status: 'pending_payment', payment_status: 'yet_to_paid' }]);
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

// ==========================================
// PAYMENTS (RAZORPAY)
// ==========================================
app.post('/api/payment/create', authenticateToken, async (req, res) => {
  try {
    const order = await razorpay.orders.create({ amount: Math.round(req.body.amount * 100), currency: "INR", receipt: req.body.order_id });
    res.status(200).json({ success: true, razorpay_order_id: order.id, amount: order.amount });
  } catch (error) {
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
    const { data, error } = await req.userSupabase.from('messages').insert([{ order_id, sender_id: req.user.id, receiver_id, content }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ADMIN PORTAL ENDPOINTS
// ==========================================
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        *,
        crop_listings (variety, quantity, unit),
        farmer:users!farmer_id (full_name, phone),
        trader:users!trader_id (full_name, phone)
      `)
      .order('created_at', { ascending: false });

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

    const { data, error } = await supabase
      .from('orders')
      .update({ status: newStatus, payment_status: paymentStatus, updated_at: new Date() })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    res.status(200).json({ success: true, message: 'Dispute resolved successfully', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch all users waiting for verification
app.get('/api/admin/verifications', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, role, phone, location, business_name, verification_status, document_type, document_url, created_at')
      .eq('verification_status', 'pending_verification')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or Reject a user's verification
app.put('/api/admin/verify/:userId', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body; // 'verified' or 'rejected'
    
    const { data, error } = await supabase
      .from('users')
      .update({ verification_status: status })
      .eq('id', req.params.userId)
      .select();

    if (error) throw error;
    res.status(200).json({ success: true, message: `User marked as ${status}`, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// USER KYC (VERIFICATION) UPLOAD (MULTIPLE FILES)
// ==========================================
app.post('/api/user/kyc', authenticateToken, upload.array('documents', 5), async (req, res) => {
  try {
    const { document_type } = req.body;
    const userId = req.user.id;

    if (!req.files || req.files.length === 0) {
      throw new Error('No document images uploaded');
    }

    const uploadedUrls = [];

    // 1. Upload ALL images to S3
    for (const file of req.files) {
      const fileExt = path.extname(file.originalname);
      const fileName = `${userId}-${Date.now()}-${Math.round(Math.random() * 1000)}${fileExt}`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: 'user_documents',
        Key: fileName,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype
      }));

      const { data: publicUrlData } = supabase.storage.from('user_documents').getPublicUrl(fileName);
      uploadedUrls.push(publicUrlData.publicUrl);
      
      // Clean up local temp file
      fs.unlinkSync(file.path);
    }

    // 2. Update the user's profile with comma-separated URLs
    const { data, error } = await supabase.from('users').update({
      verification_status: 'pending_verification',
      document_type: document_type,
      document_url: uploadedUrls.join(','), // Store multiple URLs securely
      updated_at: new Date()
    }).eq('id', userId).select();

    if (error) throw error;

    res.status(200).json({ success: true, message: 'KYC Documents submitted successfully!', data });
  } catch (error) {
    if (req.files) {
      req.files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
    }
    res.status(500).json({ error: error.message });
  }
});

const port = parseInt(process.env.PORT, 10) || 5000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));