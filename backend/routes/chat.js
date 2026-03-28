const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/chat/:order_id
 * Retrieve historical messages for a specific order.
 */
router.get('/:order_id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await req.userSupabase
      .from('messages')
      .select('*')
      .eq('order_id', req.params.order_id)
      .order('created_at', { ascending: true });
      
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat
 * Send a message within an order or direct contact flow.
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { order_id, receiver_id, content } = req.body;
    const senderId = req.user.id;

    // Direct message flow (simple persistence)
    const { data, error } = await req.userSupabase
      .from('messages')
      .insert([{ order_id, sender_id: senderId, receiver_id, content }])
      .select().single();
      
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
