const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { sendSMS } = require('../utils/notifications');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * POST /api/payment/create
 * Initialize a Razorpay payment and set up "Razorpay Route" transfers if the farmer is verified.
 */
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { listing_id, amount: rawAmount, order_id: customReceipt, quantity = 1, agreed_price } = req.body;
    const traderId = req.user.id;

    const effectivePrice = agreed_price || rawAmount;
    const effectiveQty = quantity || 1;

    // 1. Fetch listing and farmer's bank account
    const { data: listing } = await adminSupabase
      .from('crop_listings').select('farmer_id').eq('id', listing_id).single();

    const { data: bankAccount } = await adminSupabase
      .from('bank_accounts').select('razorpay_linked_account_id, is_verified')
      .eq('user_id', listing?.farmer_id).maybeSingle();

    const totalPaise = Math.round((effectivePrice * effectiveQty) * 100);
    const farmerAmountPaise = Math.round(totalPaise * 0.97); // 3% fee

    const orderPayload = {
      amount: totalPaise,
      currency: 'INR',
      receipt: customReceipt || `ord_${Date.now()}`,
      notes: { listing_id, trader_id: traderId, farmer_id: listing?.farmer_id },
    };

    // ⚡ Razorpay Route: Automatically route funds to farmer (on hold)
    if (bankAccount?.razorpay_linked_account_id && bankAccount?.is_verified) {
      orderPayload.transfers = [{
        account: bankAccount.razorpay_linked_account_id,
        amount: farmerAmountPaise,
        currency: 'INR',
        on_hold: 1, // Hold until delivery
        on_hold_until: Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000),
      }];
    }

    const razorpayOrder = await razorpay.orders.create(orderPayload);
    res.status(200).json({
      success: true,
      razorpay_order_id: razorpayOrder.id,
      amount: totalPaise
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/payment/verify
 * Verifies the Razorpay signature and finalizes the order.
 */
router.post('/verify', authenticateToken, async (req, res) => {
  try {
    const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid signature.' });
    }

    // 1. Update Order Status
    const { error: updateErr } = await adminSupabase.from('orders').update({
      payment_status: 'processing',
      razorpay_payment_id
    }).eq('id', order_id);

    if (updateErr) {
      if (updateErr.code === '23505') { // Unique constraint violation
        return res.status(200).json({ success: true, message: 'Payment already processed.' });
      }
      throw updateErr;
    }

    // 2. Atomic History Append
    await adminSupabase.rpc('append_order_history', {
      p_order_id: order_id,
      p_status: 'completed',
      p_note: `Payment verified: ${razorpay_payment_id}`,
      p_actor: 'System'
    });

    res.status(200).json({ success: true, message: 'Payment verified!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/payment/webhook
 * Razorpay Webhook — server-side payment confirmation fallback.
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).json({ error: 'Webhook secret not configured' });

    const isValid = crypto.createHmac('sha256', webhookSecret).update(req.body.toString()).digest('hex') === signature;
    if (!isValid) return res.status(400).json({ error: 'Invalid webhook signature' });

    const event = JSON.parse(req.body);
    if (event.event === 'payment.captured') {
      const orderId = event.payload.payment.entity.receipt;
      const paymentId = event.payload.payment.entity.id;

      const { error: updateErr } = await adminSupabase.from('orders').update({ 
        payment_status: 'processing', 
        razorpay_payment_id: paymentId
      }).eq('id', orderId);

      if (!updateErr) {
        await adminSupabase.rpc('append_order_history', {
          p_order_id: orderId,
          p_status: 'completed',
          p_note: `Payment captured via webhook: ${paymentId}`,
          p_actor: 'System'
        });
      }
    }
    res.json({ received: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
