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

    // 1. Sign up with Supabase Auth including all metadata
    const { data: authData, error: authError } = await adminSupabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name,
          role,
          phone,
          location,
          business_name
        }
      }
    });

    if (authError) throw authError;

    // 🛑 Note: The public.users profile is now automatically created by a 
    // Postgres trigger (handle_new_user) to ensure data integrity.

    res.status(201).json({ 
      success: true, 
      message: 'Account created successfully', 
      user: authData.user, 
      session: authData.session 
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
