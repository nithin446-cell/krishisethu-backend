const axios = require('axios');
const { sendPushNotification } = require('../notificationHelper');

/**
 * Sends a transactional SMS via Fast2SMS.
 * @param {string|string[]} phones - Single phone number or array of numbers.
 * @param {string} message - Content of the SMS.
 */
const sendSMS = async (phones, message) => {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const numbers = Array.isArray(phones) ? phones.join(',') : phones;
  if (!numbers) return;

  // Mock SMS in development to avoid 401 errors if API key is invalid/expired
  if (process.env.NODE_ENV === 'development') {
    console.log(`[SMS_MOCK] Would send to ${numbers}: "${message}"`);
    return;
  }

  if (!apiKey) {
    console.warn('[SMS] FAST2SMS_API_KEY not set — skipping SMS.');
    return;
  }

  try {
    const res = await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      { route: 'q', message, language: 'english', flash: 0, numbers },
      { headers: { authorization: apiKey }, timeout: 8000 }
    );
    if (res.data?.return !== true) {
      console.warn('[SMS] Fast2SMS response:', res.data);
    } else {
      console.log(`[SMS] Sent to ${numbers}`);
    }
  } catch (err) {
    // If it's a 401, it's an API key issue. Let's make the error clearer.
    if (err.response?.status === 401) {
      console.error('[SMS] Failed to send: Invalid Fast2SMS API Key (401 Unauthorized).');
    } else {
      console.error('[SMS] Failed to send:', err.message);
    }
  }
};

/**
 * High-level orchestration for notifications.
 * Can be expanded to include logging or event emitting.
 */
const notify = async (userId, phone, payload) => {
  const promises = [];
  
  // 1. Send SMS if phone is provided
  if (phone) {
    promises.push(sendSMS(phone, payload.body));
  }
  
  // 2. Send Push Notification if user ID is provided
  if (userId) {
    promises.push(sendPushNotification(userId, payload));
  }
  
  return Promise.all(promises);
};

module.exports = { sendSMS, sendPushNotification, notify };
