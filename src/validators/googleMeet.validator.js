const { body } = require("express-validator");

const createMeetLinkBody = [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("email is required")
    .isEmail()
    .withMessage("email must be valid"),
  body("startTime")
    .trim()
    .notEmpty()
    .withMessage("startTime is required")
    .isISO8601()
    .withMessage("startTime must be ISO 8601 date-time"),
  body("endTime")
    .trim()
    .notEmpty()
    .withMessage("endTime is required")
    .isISO8601()
    .withMessage("endTime must be ISO 8601 date-time"),
  body("summary").optional().trim().isLength({ max: 200 }),
  body("description").optional().trim().isLength({ max: 2000 }),
];

module.exports = { createMeetLinkBody };
