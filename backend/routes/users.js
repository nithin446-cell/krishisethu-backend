const express = require('express');
const router = express.Router();
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/users/:userId/rating
 * Fetch the average rating and rating count for a specific user.
 */
router.get('/:userId/rating', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await adminSupabase
      .from('users')
      .select('avg_rating, rating_count')
      .eq('id', userId)
      .single();

    if (error) throw error;
    res.json({ success: true, data: data || { avg_rating: 0, rating_count: 0 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
