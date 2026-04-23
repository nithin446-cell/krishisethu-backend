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
      adminSupabase.from('users').select('*', { count: 'exact', head: true }).eq('verification_status', 'pending_verification'),
      adminSupabase.from('order_disputes').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      adminSupabase.from('orders').select('*', { count: 'exact', head: true }).in('payment_status', ['kyc_pending', 'bank_pending', 'failed'])
    ]);

    const allOrders = orderStats || [];
    const totalGmv = (gmvStats || []).reduce((s, o) => s + (o.final_amount || 0), 0);
    const activeStatuses = ['placed', 'confirmed', 'dispatched', 'delivered'];

    res.json({
      success: true,
      data: {
        total_farmers: totalFarmers || 0,
        total_traders: totalTraders || 0,
        total_orders: allOrders.length,
        active_orders: allOrders.filter(o => activeStatuses.includes(o.status)).length,
        total_gmv: totalGmv,
        platform_revenue: totalGmv * 0.03,
        avg_order_value: gmvStats?.length ? totalGmv / gmvStats.length : 0,
        pending_kyc: (pendingKyc1 || 0) + (pendingKyc2 || 0),
        open_disputes: openDisputes || 0,
        pending_payouts: pendingPayouts || 0
      }
    });
  } catch (err) {
    console.error('[ADMIN_STATS_ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message, data: {} });
  }
});

/**
 * GET /api/admin/orders
 */
router.get('/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await adminSupabase
      .from('orders')
      .select(`
        id, status, payment_status, final_amount, created_at, delivery_photo_url,
        farmer:users!farmer_id(full_name),
        trader:users!trader_id(full_name, business_name),
        crop_listings(variety, unit, crop_pictures(image_url)),
        bid:bids(amount, quantity)
      `)
      .order('created_at', { ascending: false })
      .limit(500);
      
    if (error) {
      console.error('[ADMIN_ORDERS_DB_ERROR]', error);
      throw error;
    }

    const result = (data || []).map(o => ({
      id: o.id,
      status: o.status,
      payment_status: o.payment_status,
      final_amount: o.final_amount,
      quantity: o.bid?.quantity || 0,
      unit: o.crop_listings?.unit || 'unit',
      agreed_price: o.bid?.amount || 0,
      created_at: o.created_at,
      delivery_photo_url: o.delivery_photo_url,
      produce_image_url: o.crop_listings?.crop_pictures?.[0]?.image_url || null,
      farmer_name: o.farmer?.full_name || 'Unknown',
      trader_name: o.trader?.business_name || o.trader?.full_name || 'Unknown',
      crop_name: o.crop_listings?.variety || 'Unknown Crop',
      listing_title: '' 
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[ADMIN_ORDERS_ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

/**
 * GET /api/admin/kyc?status=pending|approved|rejected
 */
router.get('/kyc', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { data, error } = await adminSupabase
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

    // Fetch legacy users
    let legacyRecords = [];
    const legacyStatusMap = { pending: 'pending_verification', approved: 'verified', rejected: 'rejected' };
    const legacyStatus = legacyStatusMap[status];
    if (legacyStatus) {
      const { data: legacy } = await adminSupabase
        .from('users')
        .select('id, full_name, phone, email, document_url, updated_at')
        .eq('verification_status', legacyStatus);
      legacyRecords = (legacy || []).map(u => ({
        id: `legacy-${u.id}`, user_id: u.id, status,
        submitted_at: u.updated_at, user_name: u.full_name,
        user_phone: u.phone, user_email: u.email, selfie_url: u.document_url,
      }));
    }

    // Generate signed URLs for new KYC records
    const newRecords = await Promise.all((data || []).map(async k => {
      let selfieUrl = null, docUrl = null;
      if (k.selfie_path) {
        const { data: u } = await adminSupabase.storage.from('kyc-documents').createSignedUrl(k.selfie_path, 3600);
        selfieUrl = u?.signedUrl;
      }
      if (k.aadhaar_doc_path) {
        const { data: u } = await adminSupabase.storage.from('kyc-documents').createSignedUrl(k.aadhaar_doc_path, 3600);
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

    res.json({ success: true, data: [...legacyRecords, ...newRecords] });
  } catch (err) {
    console.error('[ADMIN_KYC_ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

/**
 * POST /api/admin/kyc/:userId/decision
 */
router.post('/kyc/:userId/decision', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, reason } = req.body;
    const targetId = req.params.userId;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

    // Update farmer_kyc table if record exists
    const { data: kycRecord } = await adminSupabase.from('farmer_kyc').select('id').eq('user_id', targetId).maybeSingle();
    if (kycRecord) {
      await adminSupabase.from('farmer_kyc').update({
        status: decision,
        rejection_reason: decision === 'rejected' ? (reason || 'Documents did not meet requirements') : null,
        reviewed_by: req.user.id,
        verified_at: decision === 'approved' ? new Date() : null,
        updated_at: new Date(),
      }).eq('user_id', targetId);
    }

    // Always update the base user record
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

/**
 * GET /api/admin/disputes?status=all|open|resolved
 */
router.get('/disputes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = adminSupabase
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
      id: d.id, order_id: d.order_id, status: d.status,
      reason: d.reason, details: d.details, created_at: d.created_at,
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

/**
 * POST /api/admin/disputes/:disputeId/resolve
 */
router.post('/disputes/:disputeId/resolve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decision, resolution } = req.body;
    if (!['farmer', 'trader', 'split'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision' });
    }
    const { error } = await adminSupabase
      .from('order_disputes')
      .update({ status: 'resolved', resolution, resolved_by: req.user.id, resolved_at: new Date() })
      .eq('id', req.params.disputeId);

    if (error) throw error;
    res.json({ success: true, message: 'Dispute resolved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/users?search=&role=all|farmer|trader
 */
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search = '', role = 'all' } = req.query;
    let query = adminSupabase
      .from('users')
      .select('id, full_name, phone, email, role, kyc_verified, location, business_name, created_at, status');

    if (role !== 'all') query = query.eq('role', role);
    if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);

    const { data: users, error } = await query.order('created_at', { ascending: false }).limit(200);
    if (error) throw error;

    // Enrich with order stats
    const enriched = await Promise.all((users || []).map(async (u) => {
      const isfarmer = u.role === 'farmer';
      const col = isfarmer ? 'farmer_id' : 'trader_id';
      const [{ data: orders }, { data: ratings }] = await Promise.all([
        adminSupabase.from('orders').select('id, final_amount, status').eq(col, u.id),
        adminSupabase.from('order_ratings').select('rating').eq('ratee_id', u.id),
      ]);
      const totalGmv = (orders || []).reduce((s, o) => s + (o.final_amount || 0), 0);
      const ratingsArr = (ratings || []).map(r => r.rating);
      const avgRating = ratingsArr.length > 0
        ? Math.round((ratingsArr.reduce((s, r) => s + r, 0) / ratingsArr.length) * 10) / 10 : 0;
      return {
        id: u.id, full_name: u.full_name, phone: u.phone, email: u.email, role: u.role,
        kyc_verified: !!u.kyc_verified, status: u.status || 'active',
        total_orders: orders?.length || 0, total_gmv: totalGmv,
        avg_rating: avgRating, rating_count: ratingsArr.length,
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

/**
 * PATCH /api/admin/users/:id/status
 */
router.patch('/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { error } = await adminSupabase.from('users').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/payouts?status=all|failed|kyc_pending|bank_pending
 */
router.get('/payouts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = adminSupabase
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

    const farmerIds = [...new Set((data || []).map(o => o.farmer_id))];
    const { data: banks } = await adminSupabase.from('bank_accounts').select('user_id, bank_id, account_number').in('user_id', farmerIds);
    const bankMap = (banks || []).reduce((acc, b) => { acc[b.user_id] = b; return acc; }, {});

    const result = (data || []).map(o => {
      const bank = bankMap[o.farmer_id];
      return {
        id: o.id, order_id: o.id,
        farmer_name: o.farmer?.full_name || 'Unknown', farmer_phone: o.farmer?.phone || '',
        trader_name: o.trader?.full_name || 'System', trader_phone: o.trader?.phone || '',
        crop_name: o.listing?.variety || 'Unknown Crop',
        final_amount: o.final_amount || 0,
        payout_amount: Math.round((o.final_amount || 0) * 0.97 * 100) / 100,
        status: o.payment_status, razorpay_payment_id: o.razorpay_payment_id || null,
        bank_name: bank?.bank_id || null, account_number: bank?.account_number || null,
        created_at: o.created_at,
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

/**
 * POST /api/admin/payouts/:orderId/pay
 */
router.post('/payouts/:orderId/pay', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { data: order, error: fetchErr } = await adminSupabase
      .from('orders').select('id, payment_status, final_amount, farmer_id').eq('id', orderId).single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'This order has already been paid' });

    const { error: updateErr } = await adminSupabase.from('orders').update({
      payment_status: 'paid', status: 'paid', paid_at: new Date(), updated_at: new Date()
    }).eq('id', orderId);

    if (updateErr) throw updateErr;
    console.log(`💰 [ADMIN] Manual payout triggered for order ${orderId} by admin ${req.user.id}`);
    res.json({ success: true, message: 'Payout marked as successful' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/prices/upload-csv
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

  stream.on('error', (err) => {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to read CSV file.' });
  });
});

/**
 * POST /api/admin/prices/bulk
 */
router.post('/prices/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { prices } = req.body;
    if (!prices || !Array.isArray(prices) || prices.length === 0) throw new Error('No valid price data found.');
    const { data, error } = await adminSupabase.from('market_prices').insert(prices).select();
    if (error) throw error;
    res.status(200).json({ success: true, message: `${data.length} prices uploaded successfully!`, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/prices
 */
router.delete('/prices', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { error } = await adminSupabase.from('market_prices').delete().not('id', 'is', null);
    if (error) throw error;
    res.status(200).json({ success: true, message: 'All market prices cleared successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
