const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: __dirname + '/.env' });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

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

        // Upload to Supabase Storage bucket 'crop_pictures'
        const { error: uploadError } = await supabase.storage
          .from('crop_pictures')
          .upload(filePath, fileBuffer, { contentType: file.mimetype });

        if (uploadError) throw uploadError;

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

// 3. Accept a Bid (Farmer Action)
app.put('/api/farmer/bid/:id/accept', async (req, res) => {
  try {
    const bidId = req.params.id; // The winning bid
    const { listing_id } = req.body;

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

    res.status(200).json({ message: 'Bid accepted successfully. Crop marked as sold!' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==========================================
// TRADER PORTAL ENDPOINTS
// ==========================================

// 1. Place a Bid
app.post('/api/trader/bid', async (req, res) => {
  const { listing_id, trader_id, amount } = req.body;
  const { data, error } = await supabase
    .from('bids')
    .insert([{ listing_id, trader_id, amount }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Bid placed successfully', data });
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

// 1. Get All Open Disputes
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

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));