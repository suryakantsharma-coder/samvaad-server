const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const WhatsApp = require("../models/whatsapp.model");
const WhatsAppOnboarding = require("../models/whatsappOnboarding.model");
const env = require("../config/env");
const { body, query } = require("express-validator");
const { protect } = require("../middleware/auth");
const {
  requireWhatsAppCredsAccess,
  requireWhatsAppOnboardingWriteAccess,
  ROLES,
} = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const { validObjectId } = require("../validators/common");
const {
  processWhatsAppWebhookBody,
} = require("../../whatsapp-chat-agent/workers/messageProcessor");

const router = express.Router();

const API_VERSION = "v21.0";

/**
 * Meta WhatsApp Cloud API — webhook verification (GET).
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!verifyToken) {
    console.error(
      "[WhatsApp] Webhook verify token missing: set WHATSAPP_WEBHOOK_VERIFY_TOKEN or WEBHOOK_TOKEN"
    );
    return res.sendStatus(503);
  }

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }

  console.warn("[WhatsApp] Webhook verification denied", {
    mode,
    hasChallenge: challenge != null,
  });
  return res.sendStatus(403);
});

function verifyMetaWebhookSignature(req) {
  const secret = env.FACEBOOK_APP_SECRET;
  if (!secret) {
    return true;
  }

  const sig = req.headers["x-hub-signature-256"];
  const raw = req.rawBody;

  if (!sig || !Buffer.isBuffer(raw)) {
    return false;
  }

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");

  if (sig.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Meta sends WhatsApp Business Account events (messages, statuses, etc.).
 * Acknowledge immediately with 200; optional HMAC check when FACEBOOK_APP_SECRET is set.
 */
router.post("/webhook", (req, res) => {
  if (!verifyMetaWebhookSignature(req)) {
    console.warn("[WhatsApp] Invalid or missing X-Hub-Signature-256");
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    logWhatsAppWebhookPayload(req.body);
    processWhatsAppWebhookBody(req.body);
  } catch (err) {
    console.error("[WhatsApp] Webhook handler error:", err.message);
  }
});

function logWhatsAppWebhookPayload(body) {
  if (!body || typeof body !== "object") {
    console.log("[WhatsApp] Webhook: empty or non-object body");
    return;
  }

  if (body.object && body.object !== "whatsapp_business_account") {
    console.log("[WhatsApp] Webhook object:", body.object);
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change.value && typeof change.value === "object" ? change.value : {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];

      if (messages.length) {
        console.log("[WhatsApp] messages:", JSON.stringify(messages));
      }
      if (statuses.length) {
        console.log("[WhatsApp] statuses:", JSON.stringify(statuses));
      }
    }
  }

  if (entries.length === 0) {
    console.log("[WhatsApp] Webhook payload (no entry):", JSON.stringify(body).slice(0, 800));
  }
}

function isValidObjectId(id) {
  return Boolean(id && mongoose.Types.ObjectId.isValid(String(id)));
}

const hospitalIdQuery = [
  query("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("Invalid hospitalId"),
];

async function getWhatsAppCredsForHospital(req, res, next) {
  try {
    const hospitalId = req.params.hospitalId || req.query.hospitalId;

    const creds = await WhatsApp.findOne({ hospitalId })
      .sort({ updatedAt: -1 })
      .lean();

    if (!creds) {
      return res.status(404).json({
        success: false,
        message: "No WhatsApp credentials found for this hospital",
      });
    }

    res.json({
      success: true,
      data: {
        hospitalId: String(creds.hospitalId),
        waba_id: creds.waba_id,
        phone_number_id: creds.phone_number_id,
        access_token: creds.access_token,
        api_version: creds.api_version,
        createdAt: creds.createdAt,
        updatedAt: creds.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/whatsapp/creds?hospitalId=<mongoId>
 * `admin`, `super_admin`, or `hospital_admin` for their linked hospital only.
 */
router.get(
  "/creds",
  protect,
  requireWhatsAppCredsAccess,
  ...hospitalIdQuery,
  validate,
  getWhatsAppCredsForHospital
);

/**
 * GET /api/whatsapp/hospital/:hospitalId/creds
 * Same access as `/creds`. Returns latest WhatsApp integration row (by updatedAt).
 */
router.get(
  "/hospital/:hospitalId/creds",
  protect,
  requireWhatsAppCredsAccess,
  validObjectId("hospitalId"),
  validate,
  getWhatsAppCredsForHospital
);

/**
 * For hospital_admin, `hospitalId` may be omitted; it is filled from `req.user.hospital` before validation.
 */
function ensureHospitalAdminOnboardingHospitalId(req, res, next) {
  if (
    req.user?.role === ROLES.HOSPITAL_ADMIN &&
    req.user.hospital &&
    (req.body?.hospitalId == null || req.body.hospitalId === "")
  ) {
    req.body.hospitalId = String(req.user.hospital);
  }
  next();
}

const onboardingUpsertBody = [
  body("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required (or sign in as hospital_admin with a linked hospital)")
    .isMongoId()
    .withMessage("Invalid hospitalId"),
  body("registrationPhone")
    .optional()
    .isBoolean()
    .withMessage("registrationPhone must be a boolean"),
  body("subscribeApp")
    .optional()
    .isBoolean()
    .withMessage("subscribeApp must be a boolean"),
  body("verifyRegistration")
    .optional()
    .isBoolean()
    .withMessage("verifyRegistration must be a boolean"),
];

function shapeOnboardingResponse(doc, hospitalId) {
  if (!doc) {
    return {
      hospitalId: String(hospitalId),
      registrationPhone: false,
      subscribeApp: false,
      verifyRegistration: false,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    hospitalId: String(doc.hospitalId),
    registrationPhone: Boolean(doc.registrationPhone),
    subscribeApp: Boolean(doc.subscribeApp),
    verifyRegistration: Boolean(doc.verifyRegistration),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function getWhatsAppOnboardingForHospital(req, res, next) {
  try {
    const hospitalId = req.params.hospitalId || req.query.hospitalId;
    const doc = await WhatsAppOnboarding.findOne({ hospitalId }).lean();
    res.json({
      success: true,
      data: shapeOnboardingResponse(doc, hospitalId),
      persisted: Boolean(doc),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/whatsapp/onboarding
 * Admin / super_admin: any hospitalId. Hospital admin: own hospital only (hospitalId optional — defaults to linked hospital).
 * Send one or more booleans per step as each onboarding phase completes; omitted flags stay unchanged in DB.
 */
router.put(
  "/onboarding",
  protect,
  ensureHospitalAdminOnboardingHospitalId,
  requireWhatsAppOnboardingWriteAccess,
  ...onboardingUpsertBody,
  validate,
  async (req, res, next) => {
    try {
      const { hospitalId, registrationPhone, subscribeApp, verifyRegistration } = req.body;

      const existing = await WhatsAppOnboarding.findOne({ hospitalId }).lean();

      const payload = {
        registrationPhone:
          typeof registrationPhone === "boolean"
            ? registrationPhone
            : (existing?.registrationPhone ?? false),
        subscribeApp:
          typeof subscribeApp === "boolean"
            ? subscribeApp
            : (existing?.subscribeApp ?? false),
        verifyRegistration:
          typeof verifyRegistration === "boolean"
            ? verifyRegistration
            : (existing?.verifyRegistration ?? false),
      };

      const doc = await WhatsAppOnboarding.findOneAndUpdate(
        { hospitalId },
        {
          $set: payload,
          $setOnInsert: { hospitalId },
        },
        { new: true, upsert: true, runValidators: true }
      ).lean();

      res.json({
        success: true,
        data: shapeOnboardingResponse(doc, hospitalId),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/whatsapp/onboarding?hospitalId=
 * Same access as WhatsApp creds (admin / super_admin / own hospital_admin).
 */
router.get(
  "/onboarding",
  protect,
  requireWhatsAppCredsAccess,
  ...hospitalIdQuery,
  validate,
  getWhatsAppOnboardingForHospital
);

/**
 * GET /api/whatsapp/onboarding/hospital/:hospitalId
 */
router.get(
  "/onboarding/hospital/:hospitalId",
  protect,
  requireWhatsAppCredsAccess,
  validObjectId("hospitalId"),
  validate,
  getWhatsAppOnboardingForHospital
);

/** Direct save (e.g. when you already have an access_token). */
router.post("/", async (req, res, next) => {
  try {
    const { waba_id, phone_number_id, access_token, api_version, hospitalId } =
      req.body;

    if (hospitalId != null && !isValidObjectId(hospitalId)) {
      return res.status(400).json({ success: false, error: "invalid hospitalId" });
    }

    const doc = await WhatsApp.create({
      waba_id,
      phone_number_id,
      access_token,
      api_version: api_version || API_VERSION,
      hospitalId: hospitalId || undefined,
    });

    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
});

/** Exchange OAuth code for access_token and persist (Meta embedded signup / OAuth callback). */
router.post("/callback", async (req, res) => {
  try {
    const { waba_id, phone_number_id, code, hospitalId } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, error: "code is required" });
    }
    if (hospitalId != null && !isValidObjectId(hospitalId)) {
      return res.status(400).json({ success: false, error: "invalid hospitalId" });
    }

    const clientId = env.FACEBOOK_APP_ID;
    const clientSecret = env.FACEBOOK_APP_SECRET;
    if (!clientId || !clientSecret) {
      console.error("[WhatsApp] Missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET");
      return res.status(500).json({ success: false, error: "server OAuth not configured" });
    }

    const tokenUrl = new URL(`https://graph.facebook.com/${API_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", clientId);
    tokenUrl.searchParams.set("client_secret", clientSecret);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok) {
      console.error("[WhatsApp] OAuth error:", tokenData);
      return res.status(502).json({
        success: false,
        error: "oauth_failed",
        details: tokenData.error || tokenData,
      });
    }

    const access_token = tokenData.access_token;
    if (!access_token) {
      console.error("[WhatsApp] OAuth response missing access_token:", tokenData);
      return res.status(502).json({ success: false, error: "no_access_token" });
    }

    const doc = await WhatsApp.create({
      waba_id,
      phone_number_id,
      access_token,
      api_version: API_VERSION,
      hospitalId: hospitalId || undefined,
    });

    res.json({ success: true, data: doc });
  } catch (err) {
    console.error("[WhatsApp] callback:", err.message);
    res.status(500).json({ success: false, error: "failed" });
  }
});

module.exports = router;
