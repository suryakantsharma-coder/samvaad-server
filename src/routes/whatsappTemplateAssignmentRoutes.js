const express = require("express");
const mongoose = require("mongoose");
const { body, query } = require("express-validator");
const { protect } = require("../middleware/auth");
const { requireWhatsAppCredsAccess, ROLES } = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const WhatsAppTemplateAssignment = require("../models/whatsappTemplateAssignment.model");
const {
  TEMPLATE_KEY_LIST,
  TEMPLATE_CATALOG,
  buildNormalizedTemplatePayload,
} = require("../services/whatsappTemplateAssignment.service");

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
  body("templates")
    .isObject()
    .withMessage("templates must be an object"),
  ...TEMPLATE_KEY_LIST.map((k) =>
    body(`templates.${k}`)
      .optional()
      .isString()
      .withMessage(`templates.${k} must be a string`)
  ),
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

/**
 * POST /api/whatsapp-template-assignment
 * Upsert template names per hospital + WhatsApp phone_number_id.
 * This endpoint is intended for frontend usage.
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
      const { hospitalId, phone_number_id, templates } = req.body;
      if (!isValidObjectId(hospitalId)) {
        return res.status(400).json({ success: false, message: "Invalid hospitalId" });
      }

      const normalizedPhoneNumberId = String(phone_number_id).trim();
      if (!normalizedPhoneNumberId) {
        return res
          .status(400)
          .json({ success: false, message: "phone_number_id cannot be empty" });
      }

      const normalizedTemplates = buildNormalizedTemplatePayload(templates || {});
      const updateSet = {};
      for (const key of Object.keys(normalizedTemplates)) {
        updateSet[`templates.${key}`] = normalizedTemplates[key];
      }

      if (!Object.keys(updateSet).length) {
        return res.status(400).json({
          success: false,
          message: "At least one template key is required in templates",
        });
      }

      const doc = await WhatsAppTemplateAssignment.findOneAndUpdate(
        {
          hospitalId,
          phone_number_id: normalizedPhoneNumberId,
        },
        {
          $set: updateSet,
          $setOnInsert: { hospitalId, phone_number_id: normalizedPhoneNumberId },
        },
        { new: true, upsert: true, runValidators: true }
      ).lean();

      return res.status(201).json({
        success: true,
        data: doc,
        templateKeys: TEMPLATE_KEY_LIST,
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
  });
});

module.exports = router;
