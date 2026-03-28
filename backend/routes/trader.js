const express = require('express');
const router = express.Router();
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');
const { sendPushNotification, sendSMS } = require('../utils/notifications');

/**
 * POST /api/trader/bid
 * Trader places a new bid on a listing.
 */
router.post('/bid', authenticateToken, async (req, res) => {
  try {
    const { listing_id, amount, quantity, message } = req.body;
    const { data: bid, error: bidErr } = await req.userSupabase
      .from('bids').insert([{ listing_id, trader_id: req.user.id, amount, quantity, message }])
      .select().single();
      
    if (bidErr) throw bidErr;

    // 1. Fetch listing details to notify the farmer
    const { data: listing } = await adminSupabase
      .from('crop_listings')
      .select('farmer_id, variety, users(phone, full_name)')
      .eq('id', listing_id)
      .single();

    if (listing?.farmer_id) {
      const farmerId = listing.farmer_id;
      const farmerPhone = listing.users?.phone;
      const traderName = req.user.user_metadata?.full_name || 'A Trader';

      // 📱 SMS Notification
      if (farmerPhone) {
        await sendSMS(farmerPhone, `KrishiSethu: ${traderName} ne aapki ${listing.variety || 'fasal'} par ₹${amount}/kg ka bid lagaya hai. App me dekhein.`);
      }

      // ── FCM Notification ──
      try {
        await sendPushNotification(farmerId, {
          title: 'New Bid Received! / naya Bid mila!',
          body: `${traderName} ne aapkia fasal par ₹${amount}/kg ka bid lagaya hai.`,
          data: { listing_id, type: 'NEW_BID' }
        });
      } catch (fcmErr) {
        console.error('[FCM_ERROR] Bid notification failed.', fcmErr.message);
      }
    }

    res.status(201).json({ message: 'Bid placed successfully.', data: bid });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/trader/bids
 * Get all bids placed by the current trader.
 */
router.get('/bids', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('bids')
      .select(`*, crop_listings (variety, current_price, status)`)
      .eq('trader_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/trader/orders
 * Get active orders that the trader needs to pay or track.
 */
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('orders')
      .select(`*, crop_listings (variety, unit, location), farmer:users!farmer_id (full_name, phone), bids (quantity)`)
      .eq('trader_id', req.user.id)
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
