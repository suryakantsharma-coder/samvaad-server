const { query } = require("express-validator");
const { paginationQuery } = require("./common");

/** GET /api/payments — list Razorpay payment history for one hospital */
const listPaymentsQuery = [
  query("hospitalId")
    .notEmpty()
    .withMessage("hospitalId is required")
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
  ...paginationQuery,
];

module.exports = {
  listPaymentsQuery,
};
