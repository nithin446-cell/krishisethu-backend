const express = require('express');
const router = express.Router();
const { supabase: adminSupabase } = require('../config/supabase');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/user/:id
 * Fetch public profile details for any user.
 */
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await adminSupabase
      .from('users')
      .select('id, full_name, role, phone, email, location, business_name, verification_status, kyc_verified, created_at')
      .eq('id', req.params.id)
      .single();
    
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/signup
 * Create a new user account.
 */
router.post('/signup', async (req, res) => {
  const { email, password, full_name, role, phone, location, business_name } = req.body;
  try {
    // 🛑 SECURITY LOCKDOWN: Block unauthorized admin signups
    if (role === 'admin') {
      return res.status(403).json({ success: false, error: 'Unauthorized: Cannot create admin accounts via public signup.' });
    }

    const { data: authData, error: authError } = await adminSupabase.auth.signUp({ email, password });
    if (authError) throw authError;

    const { data: userData, error: userError } = await adminSupabase.from('users').insert([{
      id: authData.user.id, role, full_name, phone, email, location, business_name
    }]).select().single();
    
    if (userError) throw userError;

    res.status(201).json({ success: true, message: 'Account created', user: userData, session: authData.session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
