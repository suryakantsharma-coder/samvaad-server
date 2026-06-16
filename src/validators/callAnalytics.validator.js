const { query } = require("express-validator");
const { paginationQuery, validObjectId } = require("./common");

const optionalDateRangeQuery = [
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
];

const optionalMonthQuery = [
  query("year")
    .optional({ values: "falsy" })
    .isInt({ min: 2000, max: 2100 })
    .withMessage("year must be valid"),
  query("month")
    .optional({ values: "falsy" })
    .isInt({ min: 1, max: 12 })
    .withMessage("month must be between 1 and 12"),
];

const superAdminCallAnalyticsListQuery = [
  ...optionalDateRangeQuery,
  ...optionalMonthQuery,
  query("hospitalId")
    .optional({ values: "falsy" })
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
];

const superAdminCallAnalyticsDetailsQuery = [
  validObjectId("hospitalId"),
  ...optionalDateRangeQuery,
  ...optionalMonthQuery,
  ...paginationQuery,
];

const adminCallAnalyticsQuery = [
  ...optionalDateRangeQuery,
  ...optionalMonthQuery,
  ...paginationQuery,
];

module.exports = {
  superAdminCallAnalyticsListQuery,
  superAdminCallAnalyticsDetailsQuery,
  adminCallAnalyticsQuery,
};
