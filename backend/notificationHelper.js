const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

// 💡 This is a placeholder. User MUST put their firebase-service-account.json in the backend folder.
let serviceAccount;
try {
  serviceAccount = require('./firebase-service-account.json');
} catch (e) {
  console.warn('[FCM] firebase-service-account.json not found. Push notifications will be disabled.');
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Sends a push notification to a specific user.
 * @param {string} userId - UUID of the recipient
 * @param {object} payload - { title, body, data }
 */
const sendPushNotification = async (userId, payload) => {
  try {
    // 1. Fetch FCM token from Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('fcm_token')
      .eq('id', userId)
      .single();

    if (error || !user?.fcm_token) {
      console.log(`[FCM] No token for user ${userId} — skipping`);
      return;
    }

    if (!serviceAccount) return;

    // 2. Construct message
    const message = {
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      token: user.fcm_token
    };

    // 3. Send via Firebase
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Successfully sent notification to ${userId}:`, response);
    return response;
  } catch (err) {
    console.error(`[FCM_ERROR] Failed to send to ${userId}:`, err.message);
    if (err.code === 'messaging/registration-token-not-registered') {
      // Cleanup stale token
      await supabase.from('users').update({ fcm_token: null }).eq('id', userId);
    }
  }
};

module.exports = { sendPushNotification };
