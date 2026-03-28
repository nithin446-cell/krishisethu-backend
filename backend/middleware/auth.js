const { createClient } = require('@supabase/supabase-js');
const { supabase: adminSupabase } = require('../config/supabase');

/**
 * Validates the Supabase JWT token and attaches the user object to the request.
 * Also creates a user-contextual Supabase client for subsequent queries.
 */
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data, error } = await adminSupabase.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    req.user = data.user;
    
    // Create a client that honors RLS for this specific user
    req.userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    
    next();
  } catch (err) {
    console.error('[AUTH_ERROR]', err.message);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};

/**
 * Restricts access to users with the 'admin' role.
 */
const requireAdmin = async (req, res, next) => {
  try {
    const { data: user, error } = await adminSupabase
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (error || user?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  } catch (err) {
    res.status(403).json({ error: 'Access denied' });
  }
};

module.exports = { authenticateToken, requireAdmin };
