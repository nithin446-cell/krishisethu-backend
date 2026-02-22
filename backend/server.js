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

// Initialize Supabase Client (Using Service Role for backend bypass of RLS where necessary)
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
// FARMER PORTAL ENDPOINTS
// ==========================================

// 1. Create a new crop listing
app.post('/api/farmer/listing', async (req, res) => {
  const { farmer_id, crop_name, description, base_price } = req.body;
  const { data, error } = await supabase
    .from('crop_listings')
    .insert([{ farmer_id, crop_name, description, base_price }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ message: 'Listing created', data });
});

// 2. Upload Crop Pictures (Real-time capability handled by Supabase Storage)
app.post('/api/farmer/listing/:id/upload', upload.single('image'), async (req, res) => {
  try {
    const listingId = req.params.id;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No image provided' });

    const fileExt = path.extname(file.originalname);
    const fileName = `${listingId}-${Date.now()}${fileExt}`;
    const filePath = `crops/${fileName}`;
    const fileBuffer = fs.readFileSync(file.path);

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('crop_pictures')
      .upload(filePath, fileBuffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('crop_pictures')
      .getPublicUrl(filePath);

    // Insert into database
    const { data, error: dbError } = await supabase
      .from('crop_pictures')
      .insert([{ listing_id: listingId, image_url: publicUrlData.publicUrl }])
      .select();

    if (dbError) throw dbError;

    // Clean up temp file
    fs.unlinkSync(file.path);

    res.status(200).json({ message: 'Image uploaded successfully', data });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path); // cleanup on error
    res.status(500).json({ error: error.message });
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

// 3. Upload Bids via CSV
app.post('/api/admin/upload-bids-csv', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file provided' });
  
  const results = [];
  const admin_id = req.body.admin_id; // Pass admin ID in form-data
  const batchId = `BATCH-${Date.now()}`;

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => {
      // Assuming CSV headers: bid_id, new_amount
      if (data.bid_id && data.new_amount) {
        results.push({
          bid_id: data.bid_id,
          historical_amount: parseFloat(data.new_amount),
          updated_by: admin_id || null,
          upload_batch_id: batchId
        });
      }
    })
    .on('end', async () => {
      try {
        if (results.length > 0) {
          const { error } = await supabase.from('bid_history').insert(results);
          if (error) throw error;
          
          if (admin_id) {
            await supabase.from('admin_logs').insert([{
              admin_id, action: 'CSV Bid Upload', target_table: 'bid_history'
            }]);
          }
        }
        fs.unlinkSync(req.file.path); // clean up
        res.status(200).json({ message: 'CSV processed successfully', rows_processed: results.length });
      } catch (err) {
        fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
      }
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});