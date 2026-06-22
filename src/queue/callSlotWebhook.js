/**
 * LiveKit Webhook Handler — Call Slot Release
 * -------------------------------------------
 * Listens for LiveKit's "room_finished" event.
 * When a call ends, this handler immediately releases the active-call slot
 * in Redis, allowing the next queued caller to be dispatched.
 *
 * Without this webhook, slots auto-expire after QUEUE_CALL_MAX_TTL_SECONDS
 * (default 1 hour) — so this webhook is optional but strongly recommended
 * for accurate slot management.
 *
 * LiveKit webhook setup:
 *   In your LiveKit server config (livekit.yaml) or Cloud dashboard, add:
 *     webhook:
 *       urls:
 *         - https://your-server.com/api/queue/webhook
 *       api_key: <your_livekit_api_key>
 *
 * The request body is verified using LIVEKIT_API_KEY + LIVEKIT_API_SECRET.
 */

const { WebhookReceiver } = require('livekit-server-sdk');
const { releaseSlot } = require('./serverQueueService');

/**
 * Express middleware — mount at POST /api/queue/webhook.
 * Requires raw body buffer (registered in app.js before global json parser).
 */
async function handleLivekitWebhook(req, res) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.warn('[Queue Webhook] LIVEKIT_API_KEY or LIVEKIT_API_SECRET not set — ignoring webhook');
    return res.status(503).json({ success: false, message: 'LiveKit not configured' });
  }

  let event;
  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    const rawBody = req.rawBody || req.body;
    const bodyString =
      Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8')
        : typeof rawBody === 'string'
          ? rawBody
          : JSON.stringify(rawBody);

    const authHeader = req.headers['authorization'] || '';
    event = await receiver.receive(bodyString, authHeader);
  } catch (err) {
    console.warn('[Queue Webhook] Signature verification failed:', err.message);
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }

  res.status(200).json({ success: true });

  // Process event asynchronously after responding
  setImmediate(async () => {
    try {
      if (event.event === 'room_finished') {
        const roomName = event.room && event.room.name ? event.room.name : null;
        if (roomName) {
          console.log(`[Queue Webhook] room_finished → releasing slot for room: ${roomName}`);
          await releaseSlot(roomName);
        }
      }
    } catch (err) {
      console.error('[Queue Webhook] Processing error:', err.message);
    }
  });
}

module.exports = { handleLivekitWebhook };
