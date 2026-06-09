const path = require("path");

// Load .env from project root (same folder as index.js / package.json)
// so MONGODB_URI is read correctly no matter where you run the app from
require("dotenv").config({
  path: path.resolve(__dirname, "..", "..", ".env"),
});

/** Strip BOM, quotes, accidental "Bearer " prefix (common .env / copy-paste mistakes). */
function normalizeMailtrapToken(raw) {
  if (raw == null) return "";
  let s = String(raw)
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\r/g, "");
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (/^Bearer\s+/i.test(s)) {
    s = s.replace(/^Bearer\s+/i, "").trim();
  }
  return s;
}

/** Parse comma-separated origins from env into a de-duplicated list. */
function parseOriginList(raw) {
  if (!raw) return [];
  return Array.from(
    new Set(
      String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function deriveUploadsCorsOrigins() {
  const envOrigins = parseOriginList(process.env.UPLOADS_CORS_ORIGINS);
  if (envOrigins.length) return envOrigins;

  const fallback = ["http://localhost:5173"];
  const oauthReturnUrl = (process.env.FRONTEND_GOOGLE_OAUTH_RETURN_URL || "").trim();
  if (oauthReturnUrl) {
    try {
      fallback.push(new URL(oauthReturnUrl).origin);
    } catch (_err) {
      // Ignore invalid URL in env and keep other fallbacks.
    }
  }
  return Array.from(new Set(fallback));
}

/**
 * Filesystem directory for public `/uploads/...` (logos, etc.). Uses repo `uploads/` by default
 * so paths do not depend on `process.cwd()`. Set `UPLOADS_ROOT` for Docker volumes.
 */
const UPLOADS_ROOT = process.env.UPLOADS_ROOT
  ? path.resolve(process.env.UPLOADS_ROOT)
  : path.resolve(__dirname, "..", "..", "uploads");

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,
  UPLOADS_ROOT,
  /**
   * Comma-separated frontend origins allowed to fetch static uploads with CORS.
   * Example:
   * UPLOADS_CORS_ORIGINS=https://dashboard.samvaadai.com,https://staging.samvaadai.com,http://localhost:5173
   */
  UPLOADS_CORS_ORIGINS: deriveUploadsCorsOrigins(),
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
   * When "1" or "true": hourly payout cron aggregates the **current** calendar month (local server time).
   * Default (unset): **previous** calendar month. Use only for testing; leave unset in production.
   */
  PAYOUT_CRON_USE_CURRENT_MONTH: (process.env.PAYOUT_CRON_USE_CURRENT_MONTH || "").trim(),
  /**
   * When "1" or "true": breakfast/lunch/dinner fire at ~2 / 25 / 48 min after each compact "day",
   * and each follow-up day is 1 hour apart (good for local testing). Leave unset in production.
   */
  REMINDER_TEST_MODE: process.env.REMINDER_TEST_MODE || "",
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
  /** Follow-up chat: base URL for tele-caller (Mongo patient ObjectId is appended as last path segment). */
  TELECALLER_BOOKING_LINK: (process.env.TELECALLER_BOOKING_LINK || "").trim(),
  /** Razorpay: REST API (orders, payments) and client-side payment signature verification. */
  RAZORPAY_KEY_ID: (process.env.RAZORPAY_KEY_ID || "").trim(),
  RAZORPAY_KEY_SECRET: (process.env.RAZORPAY_KEY_SECRET || "").trim(),
  /** Dashboard → Account & Settings → Webhooks — secret for `POST /api/razorpay/webhook` (HMAC of raw body). */
  RAZORPAY_WEBHOOK_SECRET: (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),
  /** Set to 1 or true to log each webhook POST before signature check (bytes + has signature header). */
  RAZORPAY_WEBHOOK_DEBUG: (process.env.RAZORPAY_WEBHOOK_DEBUG || "").trim(),
  /** Set to 0 to disable verbose webhook console logging. Default (unset) = verbose on (except NODE_ENV=test). */
  RAZORPAY_WEBHOOK_VERBOSE: (process.env.RAZORPAY_WEBHOOK_VERBOSE || "").trim(),
  /** Calendar used to create Meet events (`primary` or shared calendar id / email). */
  GOOGLE_CALENDAR_ID: (process.env.GOOGLE_CALENDAR_ID || "primary").trim(),
  /** OAuth 2.0 credentials for Google Calendar API. */
  GOOGLE_CLIENT_ID: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  GOOGLE_CLIENT_SECRET: (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  GOOGLE_REDIRECT_URI: (process.env.GOOGLE_REDIRECT_URI || "").trim(),
  /** HMAC secret for OAuth `state` (hospital binding). Falls back to JWT_ACCESS_SECRET if unset. */
  GOOGLE_OAUTH_STATE_SECRET: (process.env.GOOGLE_OAUTH_STATE_SECRET || "").trim(),
  /** After Google consent, browser redirect: e.g. https://dashboard.example.com/settings/integrations */
  FRONTEND_GOOGLE_OAUTH_RETURN_URL: (process.env.FRONTEND_GOOGLE_OAUTH_RETURN_URL || "")
    .trim()
    .replace(/\/$/, ""),
  /** Public base URL of this API (no trailing slash). Used in password-reset emails, e.g. http://localhost:3000 */
  API_PUBLIC_URL: (process.env.API_PUBLIC_URL || "").trim().replace(/\/$/, ""),
  /** Web app URL for welcome-after-register emails (no trailing slash), e.g. https://dashboard.samvaadai.com */
  DASHBOARD_URL: (process.env.DASHBOARD_URL || "").trim().replace(/\/$/, ""),
  /** Secret for short-lived password-reset JWTs (defaults to access secret for local dev only). */
  JWT_PASSWORD_RESET_SECRET: (process.env.JWT_PASSWORD_RESET_SECRET || "").trim() || null,
  /**
   * Mailtrap Sending API — POST https://send.api.mailtrap.io/api/send
   * Token: https://mailtrap.io/api-tokens (same value as curl `Authorization: Bearer <token>`)
   */
  MAILTRAP_API_KEY: normalizeMailtrapToken(
    process.env.MAILTRAP_API_KEY || process.env.MAILTRAP_TOKEN,
  ),
  /** Optional `category` on the send JSON (e.g. Integration Test). */
  MAILTRAP_EMAIL_CATEGORY: (process.env.MAILTRAP_EMAIL_CATEGORY || "").trim(),
  /**
   * Must match the sender domain allowed for your token (e.g. Mailtrap demo: `Mailtrap Test <hello@demomailtrap.co>`).
   */
  MAIL_FROM: (process.env.MAIL_FROM || "").trim(),
  /** Exotel Calls API integration (Basic auth using API key + token). */
  EXOTEL_REGION: (process.env.EXOTEL_REGION || "in").trim(),
  EXOTEL_ACCOUNT_SID: (process.env.EXOTEL_ACCOUNT_SID || "").trim(),
  EXOTEL_API_KEY: (process.env.EXOTEL_API_KEY || "").trim(),
  EXOTEL_API_TOKEN: (process.env.EXOTEL_API_TOKEN || "").trim(),
};

module.exports = env;
