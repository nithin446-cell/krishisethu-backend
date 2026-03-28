const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

/**
 * Helper to fetch from Razorpay API.
 */
const razorpayFetch = async (path, method = 'GET', body = null) => {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay Error');
  return data;
};

/**
 * POST /api/bank/initiate-penny-drop
 * Initiate small-amount payout for bank account verification.
 */
router.post('/initiate-penny-drop', authenticateToken, async (req, res) => {
  try {
    const { account_holder_name, account_number, ifsc_code, upi_id, account_type, bank_id } = req.body;
    const userId = req.user.id;
    const isDev = process.env.NODE_ENV !== 'production';

    // ⚡ DEV MODE Mocking
    if (isDev) {
      const referenceId = `penny_dev_${userId.slice(0, 8)}_${Date.now()}`;
      const amountPaise = 100; // Mock ₹1.00
      const hash = crypto.createHmac('sha256', process.env.PENNY_HASH_SECRET || 'secret').update(`${referenceId}:${amountPaise}`).digest('hex');
      
      await adminSupabase.from('bank_account_verifications').insert({
        user_id: userId, reference_id: referenceId, amount_hash: hash,
        account_holder_name, account_number, ifsc_code, upi_id,
        account_type: account_type || 'savings', bank_id, status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      });

      return res.json({ success: true, reference_id: referenceId, message: '[DEV] Enter ₹1.00 to verify.' });
    }

    // 💸 PRODUCTION Penny Drop (RazorpayX) logic omitted for brevity, mirrored from monolith
    res.status(501).json({ error: 'Production penny drop requires validated credentials.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/my-account', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await adminSupabase.from('bank_accounts').select('*').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ has_account: false });
    const masked = data.account_number ? '*'.repeat(data.account_number.length - 4) + data.account_number.slice(-4) : null;
    res.json({ has_account: true, ...data, account_number: masked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
