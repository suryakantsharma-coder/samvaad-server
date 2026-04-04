const path = require("path");

// Load .env from project root (same folder as index.js / package.json)
// so MONGODB_URI is read correctly no matter where you run the app from
require("dotenv").config({
  path: path.resolve(__dirname, "..", "..", ".env"),
});

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_ACCESS_SECRET:
    process.env.JWT_ACCESS_SECRET ||
    "samvaad-access-secret-change-in-production",
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET ||
    "samvaad-refresh-secret-change-in-production",
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || "15m",
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || "7d",
  COOKIE_REFRESH_MAX_AGE: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  CLOUDFLARE_DOMAIN: process.env.CLOUDFLARE_DOMAIN || null, // e.g., "your-domain.com" or "agent.your-domain.com"
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID || "",
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET || "",
  /** Must match the verify token configured in Meta → App → WhatsApp → Configuration → Webhook. */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN:
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
    process.env.WEBHOOK_TOKEN ||
    "",
  /** If set, appointment bookings send this approved template (3 body vars: patient name, link/ID, hospital name). */
  WHATSAPP_APPOINTMENT_TEMPLATE_NAME: process.env.WHATSAPP_APPOINTMENT_TEMPLATE_NAME || "",
  WHATSAPP_APPOINTMENT_TEMPLATE_LANG: process.env.WHATSAPP_APPOINTMENT_TEMPLATE_LANG || "en",
  /** Meta utility templates (NAMED body). Fallback: legacy WHATSAPP_APPOINTMENT_TEMPLATE_NAME for appointment. */
  APPOINTMENT_TEMPLATE_NAME:
    (process.env.APPOINTMENT_TEMPLATE_NAME || "").trim() ||
    (process.env.WHATSAPP_APPOINTMENT_TEMPLATE_NAME || "").trim(),
  APPOINTMENT_TEMPLATE_LANG: process.env.APPOINTMENT_TEMPLATE_LANG || "en_US",
  /** prescription_created_message — patient_name, doctor_name, link */
  PRESCRIPTION_TEMPLATE_NAME: (process.env.PRESCRIPTION_TEMPLATE_NAME || "").trim(),
  PRESCRIPTION_TEMPLATE_LANG: process.env.PRESCRIPTION_TEMPLATE_LANG || "en_US",
  /** medicines_reminder_message — patient_name, medicines */
  MEDICINE_TEMPLATE_NAME: (process.env.MEDICINE_TEMPLATE_NAME || "").trim(),
  MEDICINE_TEMPLATE_LANG: process.env.MEDICINE_TEMPLATE_LANG || "en_US",
  /** Optional URL string for template param 2 (e.g. patient portal). Falls back to appointmentId. */
  WHATSAPP_APPOINTMENT_LINK_URL: process.env.WHATSAPP_APPOINTMENT_LINK_URL || "",
  WHATSAPP_PATIENT_PORTAL_URL: process.env.WHATSAPP_PATIENT_PORTAL_URL || "",
  /**
   * WhatsApp chat: prescription links = `${WHATSAPP_PRESCRIPTION_URL_BASE}/${mongoPrescriptionId}`.
   * No trailing slash. Example: https://portal.example.com/prescriptions
   */
  WHATSAPP_PRESCRIPTION_URL_BASE: (process.env.WHATSAPP_PRESCRIPTION_URL_BASE || "").trim().replace(
    /\/$/,
    ""
  ),
  /**
   * Optional: template with `{id}` placeholder instead of URL_BASE + /id.
   * Example: https://your-app.com/patient/prescriptions/{id}
   */
  WHATSAPP_PRESCRIPTION_LINK_TEMPLATE:
    (process.env.WHATSAPP_PRESCRIPTION_LINK_TEMPLATE || "").trim(),
  /** @deprecated use WHATSAPP_PRESCRIPTION_URL_BASE; same behaviour (base + /id) */
  WHATSAPP_PRESCRIPTION_VIEW_BASE_URL: (process.env.WHATSAPP_PRESCRIPTION_VIEW_BASE_URL || "")
    .trim()
    .replace(/\/$/, ""),
  /**
   * Optional: reply via Meta Cloud when no `WhatsApp` Mongo row exists for the webhook `phone_number_id`.
   * Set with WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID for DB scope (patients/doctors).
   */
  WHATSAPP_CLOUD_ACCESS_TOKEN: (process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || "").trim(),
  /** If empty, the webhook's phone_number_id is used. If set, must match the webhook value. */
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: (process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || "").trim(),
  WHATSAPP_CLOUD_API_VERSION: process.env.WHATSAPP_CLOUD_API_VERSION || "v21.0",
  /** Redis for BullMQ (medicine reminders). If set, overrides REDIS_HOST/PORT/PASSWORD. */
  REDIS_URL: (process.env.REDIS_URL || "").trim(),
  REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
  REDIS_PORT: parseInt(process.env.REDIS_PORT, 10) || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || "",
  /** Set to "1" to run API without embedding the reminder worker (use `npm run reminder-worker`). */
  REMINDER_WORKER_DISABLED: process.env.REMINDER_WORKER_DISABLED || "",
  /**
   * WhatsAPI (self-hosted) outbound — when all three are set, the chat agent sends replies via WhatsAPI
   * instead of Meta Cloud Graph. @see https://whatsapi-docs.vercel.app/docs/sending-messages
   */
  WHATSAPI_BASE_URL: (process.env.WHATSAPI_BASE_URL || "").trim().replace(/\/$/, ""),
  WHATSAPI_TOKEN: (process.env.WHATSAPI_TOKEN || "").trim(),
  WHATSAPI_INSTANCE_KEY: (process.env.WHATSAPI_INSTANCE_KEY || "").trim(),
  /** "bearer" (default) → Authorization: Bearer <WHATSAPI_TOKEN>. "token" → Authorization: <WHATSAPI_TOKEN> raw. */
  WHATSAPI_AUTH_STYLE: process.env.WHATSAPI_AUTH_STYLE || "bearer",
  /**
   * When using WhatsAPI for send, if no Meta WhatsApp row exists for this webhook phone_number_id,
   * use this Mongo hospital id for patient/doctor/prescription context.
   */
  WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID: (process.env.WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID || "").trim(),
};

module.exports = env;
