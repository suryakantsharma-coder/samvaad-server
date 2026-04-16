const { query } = require("express-validator");
const { paginationQuery } = require("./common");

/** IST calendar-day range (same keys as appointments). */
const paymentDateRangeQuery = [
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
];

/** GET /api/payments — list by hospital; filter=all|today|tomorrow (IST day on createdAt); paymentStatus; date range overrides filter for rows */
const listPaymentsQuery = [
  query("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
  ...paginationQuery,
  query("filter")
    .optional()
    .trim()
    .isIn(["all", "today", "tomorrow"])
    .withMessage("filter must be one of: all, today, tomorrow")
    .escape(),
  query("paymentStatus")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["captured", "failed", "pending", "all"])
    .withMessage("paymentStatus must be captured, failed, pending, or all")
    .escape(),
  query("payment_status")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["captured", "failed", "pending", "all"])
    .withMessage("payment_status must be captured, failed, pending, or all")
    .escape(),
  query("sort")
    .optional()
    .trim()
    .isIn(["newest", "oldest"])
    .withMessage("sort must be newest or oldest")
    .escape(),
  ...paymentDateRangeQuery,
];

/** GET /api/payments/search — q matches payment id, order id, patient/doctor name or id */
const searchPaymentsQuery = [
  query("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
  query("q")
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage("q must be at most 200 characters")
    .escape(),
  ...paginationQuery,
  query("paymentStatus")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["captured", "failed", "pending", "all"])
    .withMessage("paymentStatus must be captured, failed, pending, or all")
    .escape(),
  query("payment_status")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["captured", "failed", "pending", "all"])
    .withMessage("payment_status must be captured, failed, pending, or all")
    .escape(),
  query("sort")
    .optional()
    .trim()
    .isIn(["newest", "oldest"])
    .withMessage("sort must be newest or oldest")
    .escape(),
  ...paymentDateRangeQuery,
];

module.exports = {
  listPaymentsQuery,
  searchPaymentsQuery,
};
