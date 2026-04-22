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

/**
 * POST /api/bank/verify-penny-drop
 * User confirms the exact amount received. Backend verifies via HMAC.
 */
router.post('/verify-penny-drop', authenticateToken, async (req, res) => {
  try {
    const { reference_id, entered_amount } = req.body;
    const userId = req.user.id;

    if (!reference_id || entered_amount === undefined) {
      return res.status(400).json({ error: 'reference_id and entered_amount are required.' });
    }

    // Fetch the pending verification record
    const { data: verif, error: fetchErr } = await adminSupabase
      .from('bank_account_verifications')
      .select('*')
      .eq('reference_id', reference_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!verif) return res.status(404).json({ error: 'Verification session not found.' });
    if (verif.status !== 'pending') return res.status(400).json({ error: `Session already ${verif.status}.` });
    if (new Date(verif.expires_at) < new Date()) return res.status(400).json({ error: 'Verification session expired. Please restart.' });

    const isDev = process.env.NODE_ENV !== 'production';

    if (isDev) {
      // In dev mode the mock always sends ₹1.00 (100 paise)
      const expectedPaise = 100;
      const enteredPaise = Math.round(parseFloat(entered_amount) * 100);

      if (enteredPaise !== expectedPaise) {
        // Increment attempts
        await adminSupabase
          .from('bank_account_verifications')
          .update({ attempts: (verif.attempts || 0) + 1 })
          .eq('reference_id', reference_id);
        return res.status(400).json({ error: '[DEV] Wrong amount. Enter ₹1.00 (the mock always deposits ₹1.00).' });
      }
    } else {
      // Production: verify via HMAC
      const enteredPaise = Math.round(parseFloat(entered_amount) * 100);
      const expectedHash = crypto
        .createHmac('sha256', process.env.PENNY_HASH_SECRET || 'secret')
        .update(`${reference_id}:${enteredPaise}`)
        .digest('hex');

      if (expectedHash !== verif.amount_hash) {
        await adminSupabase
          .from('bank_account_verifications')
          .update({ attempts: (verif.attempts || 0) + 1 })
          .eq('reference_id', reference_id);
        return res.status(400).json({ error: 'Incorrect amount. Please check your bank SMS and try again.' });
      }
    }

    // Mark as verified
    await adminSupabase
      .from('bank_account_verifications')
      .update({ status: 'amount_verified' })
      .eq('reference_id', reference_id);

    return res.json({ success: true, message: 'Amount verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bank/register-with-card
 * Final step: save bank account to bank_accounts table.
 * In dev mode, skips Razorpay and saves directly.
 */
router.post('/register-with-card', authenticateToken, async (req, res) => {
  try {
    const { reference_id, card_last6, card_expiry_month, card_expiry_year, role } = req.body;
    const userId = req.user.id;

    if (!reference_id) return res.status(400).json({ error: 'reference_id is required.' });

    // Fetch the verified verification record
    const { data: verif, error: fetchErr } = await adminSupabase
      .from('bank_account_verifications')
      .select('*')
      .eq('reference_id', reference_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!verif) return res.status(404).json({ error: 'Verification session not found.' });
    if (verif.status !== 'amount_verified') {
      return res.status(400).json({ error: 'Amount not verified yet. Please complete Step 3 first.' });
    }

    // Upsert into bank_accounts
    const { error: upsertErr } = await adminSupabase
      .from('bank_accounts')
      .upsert({
        user_id: userId,
        account_holder_name: verif.account_holder_name,
        account_number: verif.account_number || null,
        ifsc_code: verif.ifsc_code || null,
        upi_id: verif.upi_id || null,
        account_type: verif.account_type || 'savings',
        bank_id: verif.bank_id || null,
        card_last6: card_last6 || null,
        card_expiry_month: card_expiry_month || null,
        card_expiry_year: card_expiry_year || null,
        is_verified: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertErr) throw upsertErr;

    // Mark verification as completed
    await adminSupabase
      .from('bank_account_verifications')
      .update({ status: 'completed' })
      .eq('reference_id', reference_id);

    return res.json({
      success: true,
      message: 'Bank account registered successfully.',
      linked_account_id: null, // Razorpay Route integration can be added in production
    });
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
