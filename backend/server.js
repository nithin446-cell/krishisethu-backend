const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: __dirname + '/.env' });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
// Guard against missing environment variables. trim() will throw if the value is undefined,
// so we read the variable first and validate it.
const supabaseUrl = process.env.SUPABASE_URL?.trim();
if (!supabaseUrl) {
  console.error('Environment variable SUPABASE_URL is not defined. Make sure .env is loaded.');
  process.exit(1); // fail fast
}

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!supabaseKey) {
  console.error('No Supabase API key found in SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize S3 Client for Supabase Storage uploads
const s3Client = new S3Client({
  forcePathStyle: true,
  region: 'ap-south-1', // Required by AWS SDK, but Supabase ignores actual routing
  endpoint: `${supabaseUrl}/storage/v1/s3`,
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY?.trim(),
  }
});

// Configure Multer for temp file uploads
const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// ==========================================
// TRADER FEED (MARKET) ENDPOINTS - MISSING CODE ADDED
// ==========================================

// Fetch live market listings
app.get('/api/market', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('crop_listings')
      .select(`
        *,
        users ( full_name ),
        crop_pictures ( image_url ),
        bids ( * )
      `)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// FARMER PORTAL ENDPOINTS
// ==========================================

// MISSING CODE ADDED: Handle FormData with multiple images AND text in one request (Option A)
app.post('/api/farmer/upload', upload.array('images', 5), async (req, res) => {
  try {
    // 1. Extract text fields from the FormData
    const { farmer_id, crop_name, variety, quantity, unit, base_price, location, description, status } = req.body;

    // 2. Insert into crop_listings
    const { data: listingData, error: listingError } = await supabase
      .from('crop_listings')
      .insert([{
        farmer_id,
        crop_name,
        variety,
        quantity: parseFloat(quantity),
        unit,
        base_price: parseFloat(base_price),
        location,
        description,
        status: status || 'active'
      }])
      .select()
      .single();

    if (listingError) throw listingError;

    // 3. Process and upload images to Supabase Storage (if any exist)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileExt = path.extname(file.originalname);
        const fileName = `${listingData.id}-${Date.now()}-${Math.round(Math.random() * 1000)}${fileExt}`;
        const filePath = `${farmer_id}/${fileName}`;
        const fileBuffer = fs.readFileSync(file.path);

        // Upload to Supabase Storage bucket 'crop_pictures' via S3 Compatible API
        const uploadParams = {
          Bucket: 'crop_pictures',
          Key: filePath,
          Body: fileBuffer,
          ContentType: file.mimetype,
        };

        try {
          await s3Client.send(new PutObjectCommand(uploadParams));
        } catch (uploadError) {
          throw uploadError;
        }

        // Get public URL
        const { data: publicUrlData } = supabase.storage
          .from('crop_pictures')
          .getPublicUrl(filePath);

        // Save URL mapping in database
        await supabase.from('crop_pictures').insert([{
          listing_id: listingData.id,
          image_url: publicUrlData.publicUrl
        }]);

        // Clean up temp file
        fs.unlinkSync(file.path);
      }
    }

    res.status(201).json({ message: 'Produce listed successfully', data: listingData });
  } catch (error) {
    // Clean up temp files if the database crashes
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    }
    console.error("Upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. View all bids for a farmer's listings
app.get('/api/farmer/bids', async (req, res) => {
  try {
    const { farmer_id } = req.query; // Expect farmer_id as a query parameter
    if (!farmer_id) {
      return res.status(400).json({ error: 'farmer_id is required' });
    }

    const { data, error } = await supabase
      .from('bids')
      .select(`
        *,
        crop_listings!inner(farmer_id, crop_name, variety, base_price, quantity),
        users!bids_trader_id_fkey(id, full_name, phone)
      `)
      .eq('crop_listings.farmer_id', farmer_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Accept a Bid (Farmer Action)
app.put('/api/farmer/bid/:id/accept', async (req, res) => {
  try {
    const bidId = req.params.id; // The winning bid
    const { listing_id } = req.body;

    // Fetch the bid details to get the trader acting and the amount
    const { data: bidData, error: bidFetchError } = await supabase
      .from('bids')
      .select('*')
      .eq('id', bidId)
      .single();
      
    if (bidFetchError) throw bidFetchError;
    
    // Fetch the listing details for the farmer ID
    const { data: listingData, error: listingFetchError } = await supabase
      .from('crop_listings')
      .select('farmer_id')
      .eq('id', listing_id)
      .single();

    if (listingFetchError) throw listingFetchError;

    // A. Mark the winning bid as 'accepted'
    const { error: acceptError } = await supabase
      .from('bids')
      .update({ status: 'accepted' })
      .eq('id', bidId);
    if (acceptError) throw acceptError;

    // B. Mark all other bids on this listing as 'rejected'
    await supabase
      .from('bids')
      .update({ status: 'rejected' })
      .eq('listing_id', listing_id)
      .neq('id', bidId);

    // C. Update the crop listing status to 'sold'
    const { error: listingError } = await supabase
      .from('crop_listings')
      .update({ status: 'sold' })
      .eq('id', listing_id);
    if (listingError) throw listingError;

    // D. Create the final Order record
    const { error: orderError } = await supabase
      .from('orders')
      .insert([{
        listing_id: listing_id,
        bid_id: bidId,
        farmer_id: listingData.farmer_id,
        trader_id: bidData.trader_id,
        final_amount: bidData.amount,
        status: 'pending_payment'
      }]);
      
    if (orderError) throw orderError;

    res.status(200).json({ message: 'Bid accepted successfully. Order created and crop marked as sold!' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// TRADER PORTAL ENDPOINTS
// ==========================================

// 1. Place a Bid
app.post('/api/trader/bid', async (req, res) => {
  const { listing_id, trader_id, amount, quantity, message } = req.body;
  const { data, error } = await supabase
    .from('bids')
    .insert([{ listing_id, trader_id, amount, quantity, message }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Bid placed successfully', data });
});

// 2. View all bids placed by a trader
app.get('/api/trader/bids', async (req, res) => {
  try {
    const { trader_id } = req.query; // Expect trader_id as a query parameter
    if (!trader_id) {
      return res.status(400).json({ error: 'trader_id is required' });
    }

    const { data, error } = await supabase
      .from('bids')
      .select(`
        *,
        crop_listings (crop_name, variety, base_price, status)
      `)
      .eq('trader_id', trader_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Raise a Dispute
app.post('/api/trader/dispute', async (req, res) => {
  const { bid_id, trader_id, reason } = req.body;
  const { data, error } = await supabase
    .from('disputes')
    .insert([{ bid_id, trader_id, reason }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Dispute submitted to admin', data });
});

// ==========================================
// ADMIN PORTAL ENDPOINTS
// ==========================================

// 1. Get All Orders (Completed Trades)
app.get('/api/admin/orders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        crop_listings (crop_name, variety, quantity, unit),
        farmer:users!farmer_id (full_name, phone),
        trader:users!trader_id (full_name, phone)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Get All Bids (Market Activity)
app.get('/api/admin/bids', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bids')
      .select(`
        *,
        crop_listings (crop_name, variety),
        users!bids_trader_id_fkey (full_name)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Get All Open Disputes
app.get('/api/admin/disputes', async (req, res) => {
  const { data, error } = await supabase
    .from('disputes')
    .select(`*, bids(amount, crop_listings(crop_name))`)
    .eq('status', 'open')
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.status(200).json({ data });
});

// 2. Resolve Dispute
app.put('/api/admin/dispute/:id/resolve', async (req, res) => {
  const { resolution_notes, admin_id } = req.body;
  const { data, error } = await supabase
    .from('disputes')
    .update({ status: 'resolved', resolution_notes, updated_at: new Date() })
    .eq('id', req.params.id)
    .select();

  if (error) return res.status(400).json({ error: error.message });

  // Log Action
  await supabase.from('admin_logs').insert([{
    admin_id, action: 'Resolved Dispute', target_table: 'disputes', target_id: req.params.id
  }]);

  res.status(200).json({ message: 'Dispute resolved', data });
});

// Start Server with graceful handling when a port is already in use
function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', (err) => reject(err));
  });
}

async function startServer() {
  const basePort = parseInt(process.env.PORT, 10) || 5000;
  let port = basePort;
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await tryListen(port);
      console.log(`🚀 Server running on port ${port}`);
      return;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use. Trying port ${port + 1}...`);
        port += 1;
        continue;
      }
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  }

  console.error(`Could not bind to any port starting at ${basePort} after ${maxAttempts} attempts.`);
  process.exit(1);
}

startServer();