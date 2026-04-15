const { query, param, body } = require("express-validator");
const { paginationQuery } = require("./common");
const { getDateRangeFromQuery, firstTrimmedQueryValue } = require("../utils/queryDateRange");

/** Must stay in sync with `payoutSuperAdminController` patch handler. */
const PATCH_TX_STATUS_VALUES = ["captured", "failed", "authorized", "refunded", "pending"];

/** Must stay in sync with PayoutList schema enum + super_admin patch handler. */
const PATCH_PAYOUT_LIST_STATUS_VALUES = ["draft", "paid"];

/** IST calendar-day range (same as payments / appointments). Filters payout `startDate` (period month start). */
const payoutDateRangeQuery = [
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

/** GET /api/payouts — status draft|paid|all; date range on payout period startDate; hospitalId optional for platform admins */
const listPayoutsQuery = [
  query("hospitalId")
    .optional({ values: "falsy" })
    .trim()
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
  ...paginationQuery,
  query("status")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["draft", "paid", "all"])
    .withMessage("status must be draft, paid, or all")
    .escape(),
  query("payoutStatus")
    .optional({ values: "falsy" })
    .trim()
    .isIn(["draft", "paid", "all"])
    .withMessage("payoutStatus must be draft, paid, or all")
    .escape(),
  ...payoutDateRangeQuery,
];

/** PATCH /api/payouts/transactions/:id/status — body.razorpayStatus or body.status */
const patchPayoutTransactionStatus = [
  param("id")
    .notEmpty()
    .isMongoId()
    .withMessage("id must be a valid PaymentTransaction MongoDB id"),
  body("razorpayStatus")
    .optional({ values: "falsy" })
    .trim()
    .isIn(PATCH_TX_STATUS_VALUES)
    .withMessage(`razorpayStatus must be one of: ${PATCH_TX_STATUS_VALUES.join(", ")}`),
  body("status")
    .optional({ values: "falsy" })
    .trim()
    .isIn(PATCH_TX_STATUS_VALUES)
    .withMessage(`status must be one of: ${PATCH_TX_STATUS_VALUES.join(", ")}`),
  body().custom((_, { req }) => {
    const a = req.body?.razorpayStatus;
    const b = req.body?.status;
    const has = (v) => v != null && String(v).trim() !== "";
    if (!has(a) && !has(b)) {
      throw new Error("Provide razorpayStatus or status in the body");
    }
    return true;
  }),
];

/** PATCH /api/payouts/list/:id/status — body.status or body.payoutStatus */
const patchPayoutListStatus = [
  param("id")
    .notEmpty()
    .isMongoId()
    .withMessage("id must be a valid PayoutList MongoDB id"),
  body("status")
    .optional({ values: "falsy" })
    .trim()
    .isIn(PATCH_PAYOUT_LIST_STATUS_VALUES)
    .withMessage(`status must be one of: ${PATCH_PAYOUT_LIST_STATUS_VALUES.join(", ")}`),
  body("payoutStatus")
    .optional({ values: "falsy" })
    .trim()
    .isIn(PATCH_PAYOUT_LIST_STATUS_VALUES)
    .withMessage(`payoutStatus must be one of: ${PATCH_PAYOUT_LIST_STATUS_VALUES.join(", ")}`),
  body().custom((_, { req }) => {
    const a = req.body?.status;
    const b = req.body?.payoutStatus;
    const has = (v) => v != null && String(v).trim() !== "";
    if (!has(a) && !has(b)) {
      throw new Error("Provide status or payoutStatus in the body");
    }
    return true;
  }),
];

/** GET /api/payouts/transactions/search — super_admin; optional filters */
const searchPayoutTransactionsQuery = [
  query("q")
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage("q must be at most 200 characters"),
  query("hospitalId")
    .optional({ values: "falsy" })
    .trim()
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
  ...paginationQuery,
  query("razorpayStatus")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 48 })
    .escape(),
  query("transactionStatus")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 48 })
    .escape(),
  query("payment_status")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 48 })
    .escape(),
  query("status")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 48 })
    .escape(),
  ...payoutDateRangeQuery,
  query().custom((_, { req }) => {
    const q = String(req.query.q || "").trim();
    const hid = String(req.query.hospitalId || "").trim();
    const { hasDateRange } = getDateRangeFromQuery(req.query);
    const statusParam = firstTrimmedQueryValue(req.query, [
      "razorpayStatus",
      "transactionStatus",
      "payment_status",
      "status",
    ]);
    if (!q && !hid && !hasDateRange && !statusParam) {
      throw new Error(
        "Provide q and/or hospitalId and/or fromDate & toDate (or startDate & endDate) and/or status (payment status)"
      );
    }
    return true;
  }),
];

module.exports = {
  listPayoutsQuery,
  patchPayoutTransactionStatus,
  patchPayoutListStatus,
  searchPayoutTransactionsQuery,
};
