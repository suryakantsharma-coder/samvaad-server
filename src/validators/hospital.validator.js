const { body, query } = require("express-validator");
const { paginationQuery, searchQueryParam } = require("./common");

/** Optional `isActive` query for GET /hospitals and /hospitals/search (only applied for super_admin in controller). */
const optionalHospitalIsActiveQuery = query("isActive")
  .optional()
  .custom((value) => {
    if (value === undefined || value === null || value === "") return true;
    const v = String(value).toLowerCase();
    if (["true", "false", "1", "0"].includes(v)) return true;
    throw new Error("isActive must be true or false");
  });

const hospitalListQuery = [...paginationQuery, optionalHospitalIsActiveQuery];

const hospitalSearchQuery = [...searchQueryParam, optionalHospitalIsActiveQuery];

function parseReviewUrls(value) {
  if (value == null || value === "") return null;
  let arr = value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  return arr.map((u) => String(u || "").trim()).filter(Boolean);
}

/** Accepts JSON boolean or string "true"/"false" (e.g. multipart fields). */
const optionalBooleanBody = (field) =>
  body(field)
    .optional({ values: "null" })
    .custom((value) => {
      if (value === undefined || value === null || value === "") return true;
      if (typeof value === "boolean") return true;
      const v = String(value).toLowerCase();
      if (["true", "false", "1", "0"].includes(v)) return true;
      throw new Error(`${field} must be a boolean`);
    })
    .customSanitizer((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      if (typeof value === "boolean") return value;
      const v = String(value).toLowerCase();
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      return value;
    });

const reviewUrlsBody = (field, { required }) =>
  body(field)
    .custom((value) => {
      if (!required && (value === undefined || value === null || value === "")) {
        return true;
      }
      const arr = parseReviewUrls(value);
      if (required && (!arr || arr.length < 1)) {
        throw new Error("At least one review URL is required");
      }
      if (!required && arr == null) {
        throw new Error("reviewUrls must be a JSON array of URL strings");
      }
      if (!required && arr.length === 0) {
        throw new Error("At least one review URL is required when updating reviewUrls");
      }
      for (const s of arr || []) {
        try {
          // eslint-disable-next-line no-new
          new URL(s);
        } catch {
          throw new Error(`Invalid URL: ${s}`);
        }
      }
      return true;
    });

/** POST /api/hospitals — all core fields + contact/review fields required */
const createHospital = [
  body("name").trim().notEmpty().withMessage("name is required").isLength({ max: 200 }).escape(),
  body("phoneCountryCode")
    .optional()
    .trim()
    .isLength({ max: 10 })
    .escape(),
  body("phoneNumber").trim().notEmpty().withMessage("phoneNumber is required").isLength({ max: 20 }).escape(),
  body("email").trim().isEmail().withMessage("Invalid email").normalizeEmail(),
  body("contactPerson").trim().notEmpty().withMessage("contactPerson is required").isLength({ max: 200 }).escape(),
  body("registrationNumber")
    .trim()
    .notEmpty()
    .withMessage("registrationNumber is required")
    .isLength({ max: 100 })
    .escape(),
  body("address").trim().notEmpty().withMessage("address is required").isLength({ max: 500 }).escape(),
  body("city").trim().notEmpty().withMessage("city is required").isLength({ max: 100 }).escape(),
  body("state").trim().notEmpty().withMessage("state is required").isLength({ max: 100 }).escape(),
  body("pincode").trim().notEmpty().withMessage("pincode is required").isLength({ max: 20 }).escape(),
  body("url")
    .trim()
    .notEmpty()
    .withMessage("url is required")
    .isURL({ require_protocol: true })
    .isLength({ max: 500 }),
  body("emergencyNumber")
    .trim()
    .notEmpty()
    .withMessage("emergencyNumber is required")
    .isLength({ max: 40 })
    .escape(),
  body("receptionistNumber")
    .trim()
    .notEmpty()
    .withMessage("receptionistNumber is required")
    .isLength({ max: 40 })
    .escape(),
  body("whatsappNumber")
    .trim()
    .notEmpty()
    .withMessage("whatsappNumber is required")
    .isLength({ max: 40 })
    .escape(),
  reviewUrlsBody("reviewUrls", { required: true }),
  body("logoUrl").optional().trim().isLength({ max: 500 }),
  body("teleCallerPrice")
    .optional({ values: "null" })
    .isFloat({ min: 0 })
    .withMessage("teleCallerPrice must be a non-negative number")
    .toFloat(),
  optionalBooleanBody("isActive"),
];

/** PATCH /api/hospitals/:id — fields optional; reviewUrls if sent must stay a non-empty valid URL list */
const updateHospital = [
  body("name").optional().trim().notEmpty().withMessage("name cannot be empty").isLength({ max: 200 }).escape(),
  body("phoneCountryCode").optional().trim().isLength({ max: 10 }).escape(),
  body("phoneNumber").optional().trim().notEmpty().withMessage("phoneNumber cannot be empty").isLength({ max: 20 }).escape(),
  body("email").optional().trim().isEmail().withMessage("Invalid email").normalizeEmail(),
  body("contactPerson").optional().trim().isLength({ max: 200 }).escape(),
  body("registrationNumber").optional().trim().isLength({ max: 100 }).escape(),
  body("address").optional().trim().isLength({ max: 500 }).escape(),
  body("city").optional().trim().isLength({ max: 100 }).escape(),
  body("state").optional().trim().notEmpty().withMessage("state cannot be empty").isLength({ max: 100 }).escape(),
  body("pincode").optional().trim().isLength({ max: 20 }).escape(),
  body("url").optional().trim().isURL({ require_protocol: true }).isLength({ max: 500 }),
  body("emergencyNumber").optional().trim().notEmpty().isLength({ max: 40 }).escape(),
  body("receptionistNumber").optional().trim().notEmpty().isLength({ max: 40 }).escape(),
  body("whatsappNumber").optional().trim().notEmpty().isLength({ max: 40 }).escape(),
  reviewUrlsBody("reviewUrls", { required: false }),
  body("logoUrl").optional().trim().isLength({ max: 500 }).escape(),
  body("teleCallerPrice")
    .optional({ values: "null" })
    .isFloat({ min: 0 })
    .withMessage("teleCallerPrice must be a non-negative number")
    .toFloat(),
  optionalBooleanBody("isActive"),
];

module.exports = {
  hospitalListQuery,
  hospitalSearchQuery,
  createHospital,
  updateHospital,
};
