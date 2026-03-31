const express = require("express");
const { AccessToken } = require("livekit-server-sdk");

const router = express.Router();

/**
 * GET /api/livekit/token?roomName=hospital-{mongoId}&identity=optional
 * POST /api/livekit/token { roomName, identity }
 */
async function issueToken({ roomName, identity }) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    const err = new Error(
      "LiveKit not configured: set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL in .env",
    );
    err.statusCode = 503;
    throw err;
  }
  const rid = String(roomName || "").trim();
  if (!rid) {
    const err = new Error("roomName is required");
    err.statusCode = 400;
    throw err;
  }
  const ident = String(identity || "").trim() || `web-${Date.now()}`;
  const at = new AccessToken(apiKey, apiSecret, { identity: ident });
  at.addGrant({
    roomJoin: true,
    room: rid,
    canPublish: true,
    canSubscribe: true,
  });
  const token = await at.toJwt();
  return { url, token, roomName: rid, identity: ident };
}

router.get("/token", async (req, res) => {
  try {
    const data = await issueToken({
      roomName: req.query.roomName || req.query.room,
      identity: req.query.identity,
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error("[LiveKit token]", err);
    res.status(status).json({ success: false, message: err.message });
  }
});

router.post("/token", express.json({ limit: "4kb" }), async (req, res) => {
  try {
    const data = await issueToken({
      roomName: req.body && (req.body.roomName || req.body.room),
      identity: req.body && req.body.identity,
    });
    res.json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error("[LiveKit token]", err);
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
