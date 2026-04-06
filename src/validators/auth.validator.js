const { body } = require("express-validator");

/** Allowed body keys for PATCH /api/auth/me (self-service profile). */
const PROFILE_ALLOWED_FIELDS = new Set([
  "name",
  "email",
  "phoneNumber",
  "password",
  "currentPassword",
]);

function allowOnlyProfileFields(req, res, next) {
  const keys = Object.keys(req.body || {});
  const bad = keys.filter((k) => !PROFILE_ALLOWED_FIELDS.has(k));
  if (bad.length) {
    return res.status(400).json({
      success: false,
      message: `You cannot change: ${bad.join(", ")}. Only name, email, phoneNumber, and password are allowed (hospital and role cannot be changed here).`,
    });
  }
  next();
}

const updateMeProfile = [
  body("name").optional().trim().isLength({ max: 200 }).withMessage("name must be at most 200 characters"),
  body("email")
    .optional()
    .trim()
    .isEmail()
    .withMessage("Invalid email")
    .normalizeEmail(),
  body("phoneNumber").optional().trim().isLength({ max: 40 }).withMessage("phoneNumber too long"),
  body("password")
    .optional()
    .isLength({ min: 6 })
    .withMessage("password must be at least 6 characters"),
  body("currentPassword")
    .if(body("password").notEmpty())
    .notEmpty()
    .withMessage("currentPassword is required when changing password"),
];

module.exports = {
  allowOnlyProfileFields,
  updateMeProfile,
  PROFILE_ALLOWED_FIELDS,
};
