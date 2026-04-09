const crypto = require('crypto');

/**
 * Verifies Razorpay payment signature: HMAC_SHA256(order_id|payment_id, key_secret) === signature
 * @returns {boolean}
 */
function verifyRazorpayPaymentSignature(orderId, paymentId, signature, keySecret) {
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyRazorpayPaymentSignature };
