const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { supabase: adminSupabase, BUCKETS } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

// Multer setup
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const upload = multer({ dest: UPLOADS_DIR });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Bucket mapping override (legacy support)
const KYC_BUCKET = BUCKETS.KYC_DOCUMENTS || 'kyc-documents';

const s3Client = new S3Client({
  forcePathStyle: true,
  region: 'ap-south-1',
  endpoint: `${process.env.SUPABASE_URL}/storage/v1/s3`,
  credentials: {
    accessKeyId: (process.env.SUPABASE_S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.SUPABASE_S3_SECRET_ACCESS_KEY || '').trim(),
  }
});

/**
 * GET /api/kyc/health
 */
router.get('/health', (req, res) => res.json({ status: 'ok', bucket: KYC_BUCKET }));

/**
 * GET /api/kyc/status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await adminSupabase
      .from('farmer_kyc')
      .select('status, rejection_reason')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json(data || { status: 'not_started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/kyc/verify-pan
 * Mocking external verification service
 */
router.post('/verify-pan', authenticateToken, async (req, res) => {
  const { pan, name, dob } = req.body;
  // Mock success
  res.json({
    success: true,
    full_name: name || 'RAJESH KUMAR',
    dob: dob || '1985-05-15',
    status: 'VALID'
  });
});

/**
 * POST /api/kyc/aadhaar-send-otp
 */
router.post('/aadhaar-send-otp', authenticateToken, async (req, res) => {
  // Mocking client_id for OTP verification
  res.json({
    success: true,
    client_id: `mock-client-${Date.now()}`,
    message: 'OTP sent successfully'
  });
});

/**
 * POST /api/kyc/aadhaar-verify-otp
 */
router.post('/aadhaar-verify-otp', authenticateToken, async (req, res) => {
  // Mocking verification result
  res.json({
    success: true,
    full_name: 'RAJESH KUMAR',
    gender: 'M',
    dob: '15-05-1985',
    address: '123, Farmer Colony, Nashik, Maharashtra'
  });
});

/**
 * POST /api/kyc/ (Legacy support for UserProfile.tsx)
 * Handles manual document uploads without PAN/Aadhaar API verification
 */
router.post('/', authenticateToken, upload.array('documents', 5), async (req, res) => {
  console.log(`[KYC_MANUAL] Received upload request from user: ${req.user.id}`);
  try {
    const { document_type } = req.body;
    const userId = req.user.id;
    if (!req.files || req.files.length === 0) throw new Error('No document images uploaded');

    console.log(`[KYC_MANUAL] Processing ${req.files.length} files for ${document_type}`);
    const uploadedUrls = [];
    for (const file of req.files) {
      const fileName = `kyc-manual-${userId}-${Date.now()}${path.extname(file.originalname)}`;
      console.log(`[KYC_MANUAL] Uploading to S3: ${fileName}`);
      
      await s3Client.send(new PutObjectCommand({
        Bucket: KYC_BUCKET,
        Key: `${userId}/${fileName}`,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype
      }));
      
      const { data: publicUrlData } = adminSupabase.storage.from(KYC_BUCKET).getPublicUrl(`${userId}/${fileName}`);
      uploadedUrls.push(publicUrlData.publicUrl);
      console.log(`[KYC_MANUAL] File uploaded, public URL generated.`);
      
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }

    console.log(`[KYC_MANUAL] Updating user record...`);
    // 🛑 NEW: Ensure user exists in public.users (safety net for broken triggers)
    const { data: existingProfile } = await adminSupabase.from('users').select('id').eq('id', userId).maybeSingle();
    
    if (!existingProfile) {
      console.log(`[KYC_MANUAL] Profile missing for ${userId}, creating from auth metadata...`);
      const { data: authUser } = await adminSupabase.auth.admin.getUserById(userId);
      if (authUser?.user) {
        const metadata = authUser.user.user_metadata || {};
        await adminSupabase.from('users').insert({
          id: userId,
          full_name: metadata.full_name || 'Authenticated User',
          role: metadata.role || 'farmer',
          phone: metadata.phone || '',
          email: authUser.user.email || ''
        });
      }
    }

    const { error: updateErr } = await adminSupabase.from('users').update({ 
      verification_status: 'pending_verification', 
      document_type, 
      document_url: uploadedUrls.join(','), 
      updated_at: new Date() 
    }).eq('id', userId);

    if (updateErr) throw updateErr;

    console.log(`[KYC_MANUAL] Success.`);
    res.status(200).json({ success: true, message: 'KYC Documents submitted successfully!' });
  } catch (error) {
    console.error('[KYC_MANUAL_ERROR]', error);
    if (req.files) req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/kyc/submit
 * Final submission with image uploads
 */
router.post('/submit', authenticateToken, upload.fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'aadhaar_doc', maxCount: 1 }
]), async (req, res) => {
  console.log(`[KYC_SUBMIT] Received request from user: ${req.user.id}`);
  try {
    const userId = req.user.id;
    const { pan, pan_name, dob, aadhaar_client_id } = req.body;

    if (!req.files || !req.files['selfie'] || !req.files['aadhaar_doc']) {
      console.warn('[KYC_SUBMIT] Missing files:', Object.keys(req.files || {}));
      throw new Error('Required documents (selfie and aadhaar photo) are missing');
    }

    const selfieFile = req.files['selfie'][0];
    const aadhaarFile = req.files['aadhaar_doc'][0];

    // Upload to Supabase Storage via S3
    const uploadFile = async (file, prefix) => {
      const fileName = `${prefix}-${userId}-${Date.now()}${path.extname(file.originalname)}`;
      console.log(`[KYC_SUBMIT] Uploading ${prefix} to S3: ${fileName}`);
      await s3Client.send(new PutObjectCommand({
        Bucket: KYC_BUCKET,
        Key: `${userId}/${fileName}`,
        Body: fs.readFileSync(file.path),
        ContentType: file.mimetype
      }));
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return `${userId}/${fileName}`;
    };

    const selfiePath = await uploadFile(selfieFile, 'selfie');
    const aadhaarPath = await uploadFile(aadhaarFile, 'aadhaar');

    console.log('[KYC_SUBMIT] Files uploaded. Upserting kyc record...');
    // Upsert KYC record
    const { error: kycError } = await adminSupabase
      .from('farmer_kyc')
      .upsert({
        user_id: userId,
        status: 'pending',
        pan_number: pan,
        pan_name: pan_name,
        pan_dob: dob,
        selfie_path: selfiePath,
        aadhaar_doc_path: aadhaarPath,
        submitted_at: new Date()
      });

    if (kycError) throw kycError;

    // Update user verification status
    await adminSupabase.from('users').update({
      verification_status: 'pending_verification'
    }).eq('id', userId);

    console.log('[KYC_SUBMIT] Success.');
    res.json({ success: true, message: 'KYC submitted successfully' });
  } catch (err) {
    console.error('[KYC_SUBMIT_ERROR]', err);
    // Cleanup files on error
    if (req.files) {
      Object.values(req.files).flat().forEach(f => {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
