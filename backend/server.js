require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const helmet = require('helmet');
const { supabase: adminSupabase } = require('./config/supabase');

// Initialize Express with WebSocket support
const app = express();
expressWs(app);

// --- Global Midleware ---
app.use(helmet()); // Security headers
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Modular Routes ---
app.use('/api/auth', require('./routes/auth'));
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
        const { token, order_id, user_id } = parsed;
        const { data, error } = await adminSupabase.auth.getUser(token);
        
        if (error || !data.user) {
          return ws.close(1008, 'Unauthorized: Invalid token');
        }

        authenticatedUserId = data.user.id;
        isAuthorized = true;
        clearTimeout(authTimeout);

        // CASE A: Join Chat Room
        if (order_id) {
          if (!chatRooms[order_id]) chatRooms[order_id] = new Set();
          chatRooms[order_id].add(ws);
          
          ws.on('close', () => {
            chatRooms[order_id]?.delete(ws);
            if (chatRooms[order_id]?.size === 0) delete chatRooms[order_id];
          });
          
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', message: `Joined room ${order_id}` }));
        } 
        // CASE B: Notification Stream
        else if (user_id === authenticatedUserId) {
          globalConnections.set(authenticatedUserId, ws);
          ws.on('close', () => globalConnections.delete(authenticatedUserId));
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', message: 'Notifications active' }));
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
app.listen(port, () => {
  console.log(`🚀 KrishiSethu Backend Running on port ${port} [${process.env.NODE_ENV}]`);
});