const path = require('path');
require('dotenv').config({ path: path.join(__dirname, process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development') });
require('dotenv').config({ path: path.join(__dirname, '.env') }); // Fallback to .env

// KrishiSethu Backend Server
const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { supabase: adminSupabase } = require('./config/supabase');
const { authenticateToken } = require('./middleware/auth');

// Initialize Express with WebSocket support
const app = express();
expressWs(app);

// --- Rate Limiting ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: { success: false, error: 'Too many requests. Please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many auth attempts. Please try again later.' },
});

// --- Global Middleware ---
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(globalLimiter);

// --- Modular Routes ---
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/user/kyc', require('./routes/kyc')); // Handle KYC separately
app.use('/api/user', require('./routes/auth')); // Reusing for profile routes
app.use('/api/market', require('./routes/market'));
app.use('/api/farmer', require('./routes/farmer'));
app.use('/api/trader', require('./routes/trader'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/payment', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/bank', require('./routes/bank'));
app.use('/api/mandi', require('./routes/mandi'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/users', require('./routes/users'));
app.use('/api/kyc', require('./routes/kyc'));

// --- NEW: Public/Shared Data Routes ---
app.get('/api/schemes', authenticateToken, async (req, res) => {
  // Simple fetch from users for now or mock
  res.json([]);
});

app.get('/api/traders', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await adminSupabase
      .from('users')
      .select('id, full_name, business_name, location, phone')
      .eq('role', 'trader');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Secure WebSocket Implementation ---
const chatRooms = {};
const globalConnections = new Map();

app.ws('/ws', (ws, req) => {
  let authenticatedUserId = null;
  let isAuthorized = false;

  // Timeout if auth message doesn't arrive in 5 seconds
  const authTimeout = setTimeout(() => {
    if (!isAuthorized) ws.close(1008, 'Authentication timeout');
  }, 5000);

    ws.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg);

      // 1. Initial Handshake
      if (parsed.type === 'AUTH') {
        const { token, order_id: msgOrderId, user_id: msgUserId } = parsed;
        const { data, error } = await adminSupabase.auth.getUser(token);
        
        if (error || !data.user) {
          console.error('[WS_AUTH] Unauthorized:', error?.message);
          return ws.close(1008, 'Unauthorized: Invalid token');
        }

        authenticatedUserId = data.user.id;
        isAuthorized = true;
        clearTimeout(authTimeout);

        // Capture IDs from message (preferred) or query
        const finalOrderId = msgOrderId || req.query.order_id;
        const finalUserId = msgUserId || req.query.user_id;

        // CASE A: Join Chat Room
        if (finalOrderId) {
          if (!chatRooms[finalOrderId]) chatRooms[finalOrderId] = new Set();
          chatRooms[finalOrderId].add(ws);
          
          ws.on('close', () => {
            chatRooms[finalOrderId]?.delete(ws);
            if (chatRooms[finalOrderId]?.size === 0) delete chatRooms[finalOrderId];
          });
          
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', message: `Joined room ${finalOrderId}` }));
          console.log(`[WS] User ${authenticatedUserId} joined room ${finalOrderId}`);
        } 
        // CASE B: Notification Stream
        else if (finalUserId === authenticatedUserId) {
          globalConnections.set(authenticatedUserId, ws);
          ws.on('close', () => globalConnections.delete(authenticatedUserId));
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', message: 'Notifications active' }));
          console.log(`[WS] User ${authenticatedUserId} connected for notifications`);
        } else {
          ws.close(1008, 'Forbidden: ID mismatch');
        }
        return;
      }

      // 2. Operational Logic (Post-Auth)
      if (!isAuthorized) return;

      if (parsed.type === 'CHAT_MESSAGE' && parsed.order_id) {
        chatRooms[parsed.order_id]?.forEach(client => {
          if (client !== ws && client.readyState === 1) client.send(msg);
        });
      }
    } catch (e) {
      console.error('[WS_ERROR]', e.message);
    }
  });
});

// --- Global Error Handler (Sanitized) ---
app.use((err, req, res, next) => {
  console.error('[SERVER_ERROR]', err);
  
  // Syntax errors from malformed JSON
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  // Payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload too large' });
  }

  // Generic sanitized error
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'An unexpected error occurred. Please try again later.' 
    : err.message;

  res.status(status).json({ success: false, error: message });
});

const port = process.env.PORT || 10000;
const server = app.listen(port, () => {
  console.log(`🚀 KrishiSethu Backend Running on port ${port} [${process.env.NODE_ENV}]`);
});

// Handle server errors (like port already in use)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ ERROR: Port ${port} is already in use!`);
    console.error(`💡 FIX: Run 'taskkill /F /IM node.exe' in your terminal and then run 'npm run dev' again.\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});
 
