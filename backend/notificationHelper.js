const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

let serviceAccount = null;
try {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saRaw) {
    serviceAccount = JSON.parse(saRaw);
  } else {
    // Fallback search in root (deprecated)
    const saPath = require('path').join(__dirname, 'firebase-service-account.json');
    if (require('fs').existsSync(saPath)) {
      serviceAccount = require(saPath);
    }
  }
} catch (e) {
  console.warn('[FCM] Firebase Service Account configuration missing or invalid. Push notifications will be disabled.');
}

if (serviceAccount && !admin.apps.length) {
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
