const crypto = require('crypto');

/**
 * Razorpay webhook: HMAC SHA256 of the **raw** request body vs `X-Razorpay-Signature`.
 * @param {Buffer} rawBodyBuffer
 * @param {string|undefined} signatureHeader
 * @param {string} webhookSecret - Dashboard → Webhooks → secret for this endpoint
 */
function verifyRazorpayWebhookSignature(rawBodyBuffer, signatureHeader, webhookSecret) {
  if (!webhookSecret || !signatureHeader || !rawBodyBuffer || !rawBodyBuffer.length) {
    return false;
  }
  const secret = String(webhookSecret).trim();
  if (!secret) return false;

  let sig = String(signatureHeader).trim();
  // Some proxies / clients alter case; HMAC hex is case-insensitive for the value.
  if (sig.toLowerCase().startsWith('sha256=')) {
    sig = sig.slice(7).trim();
  }
  sig = sig.toLowerCase();

  const expected = crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyRazorpayWebhookSignature };
