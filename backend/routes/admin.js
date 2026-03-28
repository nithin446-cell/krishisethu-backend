const express = require('express');
const router = express.Router();
const fs = require('fs');
const csv = require('csv-parser');
const multer = require('multer');
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { sendSMS } = require('../utils/notifications');

const upload = multer({ dest: 'uploads/' });

/**
 * GET /api/admin/stats
 * Overview dashboard stats for administrators.
 */
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [
      { count: totalFarmers },
      { count: totalTraders },
      { data: orderStats },
      { data: gmvStats },
      { count: pendingKyc1 },
      { count: pendingKyc2 },
      { count: openDisputes },
      { count: pendingPayouts }
    ] = await Promise.all([
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'farmer'),
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'trader'),
      adminSupabase.from('orders').select('status, final_amount'),
      adminSupabase.from('orders').select('final_amount').in('status', ['completed', 'paid']),
      adminSupabase.from('farmer_kyc').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).or('verification_status.eq.pending_verification,verification_status.eq.unverified'),
      adminSupabase.from('order_disputes').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      adminSupabase.from('orders').select('*', { count: 'exact', head: true }).in('payment_status', ['kyc_pending', 'bank_pending', 'failed'])
    ]);

    const totalGmv = (gmvStats || []).reduce((s, o) => s + (o.final_amount || 0), 0);
    
    res.json({
      success: true,
      data: {
        total_farmers: totalFarmers || 0,
        total_traders: totalTraders || 0,
        total_orders: orderStats?.length || 0,
        total_gmv: totalGmv,
        platform_revenue: totalGmv * 0.03,
        pending_kyc: (pendingKyc1 || 0) + (pendingKyc2 || 0),
        open_disputes: openDisputes || 0,
        pending_payouts: pendingPayouts || 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/prices/upload-csv
 * Stream-upload market price data from a CSV file.
 */
router.post('/prices/upload-csv', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No CSV file uploaded.' });

  const results = [];
  const BATCH_SIZE = 5000;
  let totalInserted = 0;
  let hasError = false;

  const stream = fs.createReadStream(req.file.path).pipe(csv());

  stream.on('data', async (data) => {
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

    if (results.length >= BATCH_SIZE) {
      stream.pause();
      const batchToInsert = [...results];
      results.length = 0;
      try {
        const { error } = await adminSupabase.from('market_prices').insert(batchToInsert);
        if (error) throw error;
        totalInserted += batchToInsert.length;
        stream.resume();
      } catch (err) {
        hasError = true;
        stream.destroy();
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ success: false, error: 'Database insertion failed: ' + err.message });
      }
    }
  });

  stream.on('end', async () => {
    if (hasError) return;
    if (results.length > 0) {
      try {
        const { error } = await adminSupabase.from('market_prices').insert(results);
        if (error) throw error;
        totalInserted += results.length;
      } catch (err) {
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ success: false, error: 'Final batch insertion failed.' });
      }
    }
    fs.unlinkSync(req.file.path);
    res.status(200).json({ success: true, message: `${totalInserted} prices uploaded successfully!` });
  });
});

/**
 * POST /api/admin/kyc/:userId/decision
 * Approve or decline a KYC submission.
 */
router.post('/kyc/:userId/decision', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, reason } = req.body;
    const targetId = req.params.userId;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

    await adminSupabase.from('users').update({
      kyc_verified: decision === 'approved',
      verification_status: decision === 'approved' ? 'verified' : 'rejected',
      updated_at: new Date(),
    }).eq('id', targetId);

    const { data: user } = await adminSupabase.from('users').select('phone').eq('id', targetId).single();
    if (user?.phone) {
      const msg = decision === 'approved' 
        ? `KrishiSethu: Badhai ho! Aapka KYC approved ho gaya. Ab aap fasal bech sakte hain.` 
        : `KrishiSethu: Aapka KYC rejected hua. Reason: ${reason || 'Incomplete'}`;
      await sendSMS(user.phone, msg);
    }

    res.json({ success: true, decision });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
