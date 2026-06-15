const express = require("express");
const mongoose = require("mongoose");
const { body, query } = require("express-validator");
const { protect } = require("../middleware/auth");
const { requireWhatsAppCredsAccess, ROLES } = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const WhatsAppTemplateAssignment = require("../models/whatsappTemplateAssignment.model");
const WhatsApp = require("../models/whatsapp.model");
const {
  TEMPLATE_KEY_LIST,
  TEMPLATE_CATALOG,
  getAssignedTemplateName,
  getEnvTemplateNames,
  getEnvTemplateLangByKey,
} = require("../services/whatsappTemplateAssignment.service");
const {
  sendWhatsAppTemplate,
  templateBodyNamedParameters,
} = require("../services/whatsappCloud");
const { metaTemplatePayloadForKey } = require("../services/metaWhatsAppTemplates");

const router = express.Router();

function isValidObjectId(id) {
  return Boolean(id && mongoose.Types.ObjectId.isValid(String(id)));
}

function ensureHospitalAdminHospitalId(req, _res, next) {
  if (
    req.user?.role === ROLES.HOSPITAL_ADMIN &&
    req.user.hospital &&
    (req.body?.hospitalId == null || req.body.hospitalId === "")
  ) {
    req.body.hospitalId = String(req.user.hospital);
  }
  next();
}

const writeBody = [
  body("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("Invalid hospitalId"),
  body("phone_number_id")
    .notEmpty()
    .withMessage("phone_number_id is required")
    .isString()
    .withMessage("phone_number_id must be a string"),
  body("languageCode")
    .optional()
    .isString()
    .withMessage("languageCode must be a string"),
];

const readQuery = [
  query("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("Invalid hospitalId"),
  query("phone_number_id")
    .notEmpty()
    .withMessage("phone_number_id is required")
    .isString()
    .withMessage("phone_number_id must be a string"),
];

const META_TEMPLATE_API_VERSION = "v23.0";

async function fetchExistingMetaTemplates({ wabaId, accessToken }) {
  /** @type {Map<string, { status?: string, id?: string }>} */
  const byName = new Map();
  let nextUrl = `https://graph.facebook.com/${META_TEMPLATE_API_VERSION}/${wabaId}/message_templates?limit=100&fields=name,status,id`;

  for (let i = 0; i < 20 && nextUrl; i += 1) {
    const res = await fetch(nextUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `Meta template list HTTP ${res.status}`;
      throw new Error(`[WhatsApp Template Assignment] Failed to list templates: ${msg}`);
    }
    const rows = Array.isArray(data?.data) ? data.data : [];
    for (const row of rows) {
      const name = String(row?.name || "").trim();
      if (!name) continue;
      byName.set(name, {
        status: row?.status ? String(row.status).toUpperCase() : undefined,
        id: row?.id ? String(row.id) : undefined,
      });
    }
    nextUrl = data?.paging?.next || "";
  }
  return byName;
}

async function deleteMetaTemplateByName({ wabaId, accessToken, templateName }) {
  const url = new URL(
    `https://graph.facebook.com/${META_TEMPLATE_API_VERSION}/${wabaId}/message_templates`
  );
  url.searchParams.set("name", templateName);
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Meta delete template HTTP ${res.status}`;
    const err = new Error(msg);
    err.meta = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function createMetaTemplate({ wabaId, accessToken, payload }) {
  const url = `https://graph.facebook.com/${META_TEMPLATE_API_VERSION}/${wabaId}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Meta create template HTTP ${res.status}`;
    const err = new Error(msg);
    err.meta = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Meta error 2388023: template language still deleting after DELETE. */
function isMetaTemplateDeletingError(err) {
  return err?.meta?.error?.error_subcode === 2388023;
}

async function createMetaTemplateWithRetry({
  wabaId,
  accessToken,
  payload,
  maxAttempts = 4,
  delayMs = 20000,
}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await createMetaTemplate({ wabaId, accessToken, payload });
    } catch (e) {
      lastErr = e;
      if (!isMetaTemplateDeletingError(e) || attempt === maxAttempts) {
        throw e;
      }
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

const testSendBody = [
  body("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("Invalid hospitalId"),
  body("phone_number_id")
    .notEmpty()
    .withMessage("phone_number_id is required")
    .isString()
    .withMessage("phone_number_id must be a string"),
  body("to")
    .notEmpty()
    .withMessage("to is required")
    .isString()
    .withMessage("to must be a string"),
  body("templateKey")
    .notEmpty()
    .withMessage("templateKey is required")
    .isIn(TEMPLATE_KEY_LIST)
    .withMessage(`templateKey must be one of: ${TEMPLATE_KEY_LIST.join(", ")}`),
  body("languageCode")
    .optional()
    .isString()
    .withMessage("languageCode must be a string"),
  body("variables")
    .optional()
    .isObject()
    .withMessage("variables must be an object"),
];

/**
 * POST /api/whatsapp-template-assignment
 * Upsert template names per hospital + WhatsApp phone_number_id.
 * Template names are always read from server .env (APPOINTMENT_TEMPLATE_NAME, etc.).
 */
router.post(
  "/",
  protect,
  ensureHospitalAdminHospitalId,
  requireWhatsAppCredsAccess,
  ...writeBody,
  validate,
  async (req, res, next) => {
    try {
      const { hospitalId, phone_number_id, languageCode } = req.body;
      if (!isValidObjectId(hospitalId)) {
        return res.status(400).json({ success: false, message: "Invalid hospitalId" });
      }

      const normalizedPhoneNumberId = String(phone_number_id).trim();
      if (!normalizedPhoneNumberId) {
        return res
          .status(400)
          .json({ success: false, message: "phone_number_id cannot be empty" });
      }

      const normalizedTemplates = getEnvTemplateNames();
      const updateSet = {};
      for (const key of Object.keys(normalizedTemplates)) {
        updateSet[`templates.${key}`] = normalizedTemplates[key];
      }

      if (!Object.keys(updateSet).length) {
        return res.status(400).json({
          success: false,
          message:
            "No template names in .env. Set APPOINTMENT_TEMPLATE_NAME, PRESCRIPTION_TEMPLATE_NAME, MEDICINE_TEMPLATE_NAME, and FINAL_MEDICINE_REMINDER_TEMPLATE_NAME (or DOSAGE_COMPLETION_TEMPLATE_NAME for the 4th template).",
          envTemplateNames: getEnvTemplateNames(),
        });
      }

      // Ensure template exists in Meta WABA using message_templates API before assignment save.
      const creds = await WhatsApp.findOne({
        hospitalId,
        phone_number_id: normalizedPhoneNumberId,
      })
        .sort({ updatedAt: -1 })
        .lean();

      if (!creds?.waba_id || !creds?.access_token) {
        return res.status(404).json({
          success: false,
          message:
            "No WhatsApp credentials found for provided hospitalId + phone_number_id (waba_id/access_token required)",
        });
      }

      const existingTemplates = await fetchExistingMetaTemplates({
        wabaId: String(creds.waba_id).trim(),
        accessToken: creds.access_token,
      });

      const metaCreation = [];
      const createdNames = new Set();
      for (const key of Object.keys(normalizedTemplates)) {
        const templateName = normalizedTemplates[key];
        if (!templateName) continue;

        if (createdNames.has(templateName)) {
          metaCreation.push({
            templateKey: key,
            templateName,
            created: false,
            reason: "already_processed_for_name",
          });
          continue;
        }

        const existing = existingTemplates.get(templateName);
        if (existing?.status === "APPROVED" || existing?.status === "PENDING") {
          createdNames.add(templateName);
          metaCreation.push({
            templateKey: key,
            templateName,
            created: false,
            reason: "already_exists",
            status: existing.status,
          });
          continue;
        }

        let deletedRejected = false;
        if (existing?.status === "REJECTED") {
          try {
            await deleteMetaTemplateByName({
              wabaId: String(creds.waba_id).trim(),
              accessToken: creds.access_token,
              templateName,
            });
            deletedRejected = true;
            metaCreation.push({
              templateKey: key,
              templateName,
              deletedRejected: true,
            });
            // Meta needs time to finish deletion before recreate (error 2388023).
            await sleep(5000);
          } catch (e) {
            metaCreation.push({
              templateKey: key,
              templateName,
              created: false,
              reason: "delete_rejected_failed",
              error: e.message,
              metaError: e.meta || null,
            });
            continue;
          }
        }

        const payload = metaTemplatePayloadForKey(
          key,
          templateName,
          languageCode || getEnvTemplateLangByKey(key)
        );
        if (!payload) {
          metaCreation.push({
            templateKey: key,
            templateName,
            created: false,
            reason: "unsupported_template_key",
          });
          continue;
        }
        try {
          const created = await createMetaTemplateWithRetry({
            wabaId: String(creds.waba_id).trim(),
            accessToken: creds.access_token,
            payload,
            maxAttempts: deletedRejected ? 4 : 1,
            delayMs: 20000,
          });
          createdNames.add(templateName);
          metaCreation.push({
            templateKey: key,
            templateName,
            created: true,
            meta: created,
          });
        } catch (e) {
          metaCreation.push({
            templateKey: key,
            templateName,
            created: false,
            reason: isMetaTemplateDeletingError(e)
              ? "create_failed_meta_still_deleting"
              : "create_failed",
            error: e.message,
            metaError: e.meta || null,
            hint: isMetaTemplateDeletingError(e)
              ? "Meta is still deleting the old template. Wait ~1 minute and call this API again."
              : undefined,
          });
        }
      }

      const doc = await WhatsAppTemplateAssignment.findOneAndUpdate(
        {
          hospitalId,
          phone_number_id: normalizedPhoneNumberId,
        },
        {
          $set: updateSet,
          $unset: {
            "templates.dosageCompletion": "",
            "templates.dosageFollowupNotYet": "",
            "templates.medicationCourseCompleted": "",
          },
          $setOnInsert: { hospitalId, phone_number_id: normalizedPhoneNumberId },
        },
        { new: true, upsert: true, runValidators: true }
      ).lean();

      return res.status(201).json({
        success: true,
        data: doc,
        templateKeys: TEMPLATE_KEY_LIST,
        resolvedTemplateNames: normalizedTemplates,
        envTemplateNames: getEnvTemplateNames(),
        metaCreation,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/whatsapp-template-assignment?hospitalId=<id>&phone_number_id=<id>
 */
router.get(
  "/",
  protect,
  requireWhatsAppCredsAccess,
  ...readQuery,
  validate,
  async (req, res, next) => {
    try {
      const { hospitalId, phone_number_id } = req.query;
      const doc = await WhatsAppTemplateAssignment.findOne({
        hospitalId,
        phone_number_id: String(phone_number_id).trim(),
      }).lean();
      if (!doc) {
        return res.status(404).json({
          success: false,
          message: "No template assignment found for this hospital and phone number",
        });
      }
      return res.json({ success: true, data: doc, templateKeys: TEMPLATE_KEY_LIST });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/whatsapp-template-assignment/catalog
 * Returns the fixed template definitions provided by product/PDF.
 */
router.get("/catalog", protect, async (_req, res) => {
  return res.json({
    success: true,
    templateKeys: TEMPLATE_KEY_LIST,
    templates: TEMPLATE_CATALOG,
    envTemplateNames: getEnvTemplateNames(),
  });
});

/**
 * POST /api/whatsapp-template-assignment/test-send
 * Test send a template to verify assigned template resolution + Graph delivery.
 */
router.post(
  "/test-send",
  protect,
  ensureHospitalAdminHospitalId,
  requireWhatsAppCredsAccess,
  ...testSendBody,
  validate,
  async (req, res, next) => {
    try {
      const {
        hospitalId,
        phone_number_id,
        to,
        templateKey,
        languageCode,
        variables = {},
      } = req.body;

      const normalizedPhoneNumberId = String(phone_number_id).trim();
      const creds = await WhatsApp.findOne({
        hospitalId,
        phone_number_id: normalizedPhoneNumberId,
      })
        .sort({ updatedAt: -1 })
        .lean();

      if (!creds?.access_token) {
        return res.status(404).json({
          success: false,
          message: "No WhatsApp credentials found for provided hospitalId + phone_number_id",
        });
      }

      const assignedTemplate = await getAssignedTemplateName({
        hospitalId,
        phoneNumberId: normalizedPhoneNumberId,
        templateKey,
      });

      const envFallbackByKey = getEnvTemplateNames();
      const resolvedTemplateName = assignedTemplate || envFallbackByKey[templateKey] || "";
      if (!resolvedTemplateName) {
        return res.status(400).json({
          success: false,
          message: `No template assigned/fallback found for key: ${templateKey}`,
        });
      }

      const graphResp = await sendWhatsAppTemplate({
        phoneNumberId: normalizedPhoneNumberId,
        accessToken: creds.access_token,
        to,
        templateName: resolvedTemplateName,
        languageCode: languageCode || getEnvTemplateLangByKey(templateKey),
        components: templateBodyNamedParameters(variables),
        apiVersion: creds.api_version || undefined,
      });

      return res.json({
        success: true,
        data: {
          hospitalId: String(hospitalId),
          phone_number_id: normalizedPhoneNumberId,
          templateKey,
          assignedTemplate: assignedTemplate || null,
          resolvedTemplateName,
          to,
          graphResponse: graphResp,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
