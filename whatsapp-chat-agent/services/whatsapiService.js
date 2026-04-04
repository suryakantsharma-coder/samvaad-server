const env = require("../../src/config/env");
const { normalizeWhatsAppTo } = require("../../src/services/whatsappCloud");

/**
 * Self-hosted WhatsAPI (manjit/whatsapi) — send plain text.
 * @see https://whatsapi-docs.vercel.app/docs/sending-messages
 *
 * POST {base}/api/instances/{instance_key}/send/text
 * Body: { "text": "...", "to": "919876543210" }
 * Auth: Bearer token from config `tokens[]`
 */

function isWhatsApiConfigured() {
  const base = (env.WHATSAPI_BASE_URL || "").trim();
  const token = (env.WHATSAPI_TOKEN || "").trim();
  const key = (env.WHATSAPI_INSTANCE_KEY || "").trim();
  return Boolean(base && token && key);
}

/**
 * @param {object} opts
 * @param {string} opts.to - Recipient (normalized to country+number, no +)
 * @param {string} opts.textBody
 * @param {string} [opts.defaultCountryDigits]
 */
async function sendWhatsApiText({ to, textBody, defaultCountryDigits }) {
  if (!isWhatsApiConfigured()) {
    throw new Error("WhatsAPI is not configured (WHATSAPI_BASE_URL, WHATSAPI_TOKEN, WHATSAPI_INSTANCE_KEY)");
  }

  const base = env.WHATSAPI_BASE_URL.replace(/\/$/, "");
  const instanceKey = encodeURIComponent(env.WHATSAPI_INSTANCE_KEY.trim());
  const url = `${base}/api/instances/${instanceKey}/send/text`;

  const toDigits = defaultCountryDigits
    ? normalizeWhatsAppTo(to, defaultCountryDigits)
    : normalizeWhatsAppTo(to);
  if (!toDigits) {
    throw new Error("Invalid WhatsApp recipient phone");
  }

  const text = String(textBody || "").slice(0, 4096);

  const headers = {
    "Content-Type": "application/json",
  };

  const authStyle = (env.WHATSAPI_AUTH_STYLE || "bearer").toLowerCase();
  if (authStyle === "token") {
    headers.Authorization = env.WHATSAPI_TOKEN.trim();
  } else {
    headers.Authorization = `Bearer ${env.WHATSAPI_TOKEN.trim()}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, to: toDigits }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.message ||
      data.error ||
      (typeof data === "string" ? data : null) ||
      `WhatsAPI HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data;
    throw err;
  }

  return data;
}

module.exports = {
  isWhatsApiConfigured,
  sendWhatsApiText,
};
