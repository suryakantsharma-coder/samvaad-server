/**
 * Queue Routes
 * ------------
 * GET  /api/queue/status   — live queue stats (active calls, waiting callers, slots)
 * POST /api/queue/webhook  — LiveKit room_finished webhook → releases call slot
 *
 * The webhook endpoint needs the raw body for signature verification.
 * It is registered with a custom JSON parser in app.js (see index.js hookup).
 */

const express = require('express');
const { getQueueStats } = require('../queue/serverQueueService');
const { handleLivekitWebhook } = require('../queue/callSlotWebhook');

const router = express.Router();

/**
 * GET /api/queue/status
 * Returns real-time queue stats. No auth required (internal/ops use).
 * Add auth middleware here if exposing publicly.
 */
router.get('/status', async (req, res) => {
  try {
    const data = await getQueueStats();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[Queue Routes] getQueueStats error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/queue/webhook
 * LiveKit sends room lifecycle events here.
 * Raw body is captured by the app-level queueWebhookJson parser in app.js
 * (must run before the global 10 kb JSON parser to preserve rawBody for HMAC).
 */
router.post('/webhook', handleLivekitWebhook);

module.exports = router;
