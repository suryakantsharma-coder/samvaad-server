/**
 * Temporary Meta / WhatsApp webhook at app root (no /api prefix).
 * Use callback URL: https://<host>/whatsapp/webhook
 * Remove or merge into /api/whatsapp/webhook when dashboard URL is updated.
 */
const express = require("express");
const env = require("../config/env");
const {
  processWhatsAppWebhookBody,
} = require("../../whatsapp-chat-agent/workers/messageProcessor");

const router = express.Router();

router.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!verifyToken) {
    console.error(
      "[WhatsApp root webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN or WEBHOOK_TOKEN not set"
    );
    return res.status(503).send("Service Unavailable");
  }

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }

  console.warn("[WhatsApp root webhook] verification denied", { mode });
  return res.status(403).send("Forbidden");
});

router.post("/whatsapp/webhook", (req, res) => {
  try {
    const body = req.body;
    console.log("[WhatsApp root webhook] POST raw body keys:", body && typeof body === "object" ? Object.keys(body) : typeof body);
    console.log("[WhatsApp root webhook] POST:", JSON.stringify(body, null, 2).slice(0, 12000));

    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value && typeof change.value === "object" ? change.value : {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        if (messages.length) {
          console.log("[WhatsApp root webhook] messages:", JSON.stringify(messages));
        }
        if (statuses.length) {
          console.log("[WhatsApp root webhook] statuses:", JSON.stringify(statuses));
        }
      }
    }

    processWhatsAppWebhookBody(body);
  } catch (err) {
    console.error("[WhatsApp root webhook] log error:", err.message);
  }

  res.sendStatus(200);
});

module.exports = router;
