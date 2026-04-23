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

    // 0. Check if email or phone already exists to provide a better error message
    const { data: existingUser } = await adminSupabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},phone.eq.${phone}`)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email or Phone number is already registered. Please Login instead.' 
      });
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

    // 2. Fetch the newly created public profile
    const { data: profile } = await adminSupabase
      .from('users')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    res.status(201).json({ 
      success: true, 
      message: 'Account created successfully', 
      user: profile || {
        id: authData.user.id,
        full_name: full_name,
        role: role,
        email: email
      }, 
      session: authData.session 
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
