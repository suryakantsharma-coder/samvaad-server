const Razorpay = require('razorpay');
const env = require('../config/env');

/**
 * @returns {import('razorpay') | null} Razorpay SDK instance, or null if keys are missing.
 */
function getRazorpayInstance() {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

module.exports = { getRazorpayInstance };
