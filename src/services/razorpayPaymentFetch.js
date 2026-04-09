const env = require('../config/env');

/**
 * Fetches payment from Razorpay REST API (authoritative amount, status, payer hints).
 * @returns {Promise<object|null>} normalized fields or null on failure
 */
async function fetchRazorpayPayment(paymentId) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !paymentId) return null;

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const url = `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      amount: typeof data.amount === 'number' ? data.amount : undefined,
      currency: data.currency || 'INR',
      status: data.status,
      method: data.method,
      email: data.email,
      contact: data.contact,
      createdAt: data.created_at ? new Date(data.created_at * 1000) : undefined,
    };
  } catch {
    return null;
  }
}

module.exports = { fetchRazorpayPayment };
