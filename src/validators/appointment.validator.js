const { body, query } = require("express-validator");
const { validObjectIdBody, paginationQuery } = require("./common");

const createAppointment = [
  validObjectIdBody("patient"),
  validObjectIdBody("doctor"),
  body("reason")
    .trim()
    .notEmpty()
    .withMessage("reason is required")
    .isLength({ max: 500 })
    .withMessage("reason must be at most 500 characters")
    .escape(),
  body("status")
    .optional()
    .trim()
    .isIn(["Today", "Upcoming", "Completed", "Cancelled"])
    .withMessage("status must be one of: Today, Upcoming, Completed, Cancelled")
    .escape(),
  body("type")
    .optional()
    .trim()
    .isIn([
      "hospital",
      "zoom",
      "call",
      "video_call",
      "visit",
      "online",
      "checkup",
      "consultation",
      "emergency",
      "tele-caller",
    ])
    .withMessage("type must be a valid appointment type")
    .escape(),
  body("appointmentDateTime")
    .notEmpty()
    .withMessage("appointmentDateTime is required")
    .isISO8601()
    .withMessage("appointmentDateTime must be a valid ISO 8601 date"),
  body("videoUrl")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 2048 })
    .withMessage("videoUrl must be at most 2048 characters")
    .isURL({ require_protocol: true })
    .withMessage("videoUrl must be a valid URL (e.g. Google Meet link)"),
];

const updateAppointment = [
  body("patient").optional().isMongoId().withMessage("Invalid patient id"),
  body("doctor").optional().isMongoId().withMessage("Invalid doctor id"),
  body("reason")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("reason cannot be empty")
    .isLength({ max: 500 })
    .withMessage("reason must be at most 500 characters")
    .escape(),
  body("status")
    .optional()
    .trim()
    .isIn(["Today", "Upcoming", "Completed", "Cancelled"])
    .withMessage("status must be one of: Today, Upcoming, Completed, Cancelled")
    .escape(),
  body("type")
    .optional()
    .trim()
    .isIn([
      "hospital",
      "zoom",
      "call",
      "video_call",
      "visit",
      "online",
      "checkup",
      "consultation",
      "emergency",
      "tele-caller",
    ])
    .withMessage("type must be a valid appointment type")
    .escape(),
  body("appointmentDateTime")
    .optional()
    .isISO8601()
    .withMessage("appointmentDateTime must be a valid ISO 8601 date"),
  body("videoUrl")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 2048 })
    .withMessage("videoUrl must be at most 2048 characters")
    .isURL({ require_protocol: true })
    .withMessage("videoUrl must be a valid URL (e.g. Google Meet link)"),
];

/** GET /api/appointments list: filter (all|today|tomorrow); date range fromDate/toDate or startDate/endDate (ISO YYYY-MM-DD = IST calendar day); doctor (ObjectId | doctorId | name), doctorId, patientId, status, type, sortOrder, pagination. filter=today|tomorrow wins over date range for listed rows. */
const appointmentListQuery = [
  ...paginationQuery,
  query("filter")
    .optional()
    .trim()
    .isIn(["all", "today", "tomorrow"])
    .withMessage("filter must be one of: all, today, tomorrow")
    .escape(),
  query("fromDate")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("fromDate must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("toDate")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("toDate must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("startDate")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("startDate must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("endDate")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("endDate must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("from_date")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("from_date must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("to_date")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("to_date must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("start_date")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("start_date must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("end_date")
    .optional({ values: "falsy" })
    .trim()
    .isISO8601()
    .withMessage("end_date must be a valid ISO date (e.g. YYYY-MM-DD)")
    .escape(),
  query("doctorId").optional().trim().isMongoId().withMessage("Invalid doctorId"),
  query("doctor")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 200 })
    .withMessage("doctor must be at most 200 characters"),
  query("patientId").optional().trim().isMongoId().withMessage("Invalid patientId"),
  query("status")
    .optional()
    .trim()
    .isIn(["Today", "Upcoming", "Completed", "Cancelled"])
    .withMessage("status must be one of: Today, Upcoming, Completed, Cancelled")
    .escape(),
  query("type")
    .optional()
    .trim()
    .isIn([
      "hospital",
      "zoom",
      "call",
      "video_call",
      "visit",
      "online",
      "checkup",
      "consultation",
      "emergency",
      "tele-caller",
    ])
    .withMessage("type must be a valid appointment type")
    .escape(),
  query("sortOrder")
    .optional()
    .trim()
    .isIn(["asc", "desc"])
    .withMessage("sortOrder must be asc (oldest appointment first) or desc (newest by date first)")
    .escape(),
];

module.exports = {
  createAppointment,
  updateAppointment,
  appointmentListQuery,
};
