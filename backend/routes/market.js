const express = require('express');
const router = express.Router();
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/market
 * List all active crop listings for traders to browse.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('crop_listings')
      .select(`*, users ( full_name, location, business_name ), crop_pictures ( image_url ), bids ( * )`)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    
    // Map data to expected format for the frontend
    const results = data.map(item => ({
      ...item,
      images: item.crop_pictures?.map(pic => pic.image_url) || []
    }));
    
    res.status(200).json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/market/prices
 * Fetch historical market prices for analytics.
 */
router.get('/prices', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await adminSupabase
      .from('market_prices')
      .select('*')
      .order('price_date', { ascending: false })
      .order('created_at', { ascending: false });
      
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
