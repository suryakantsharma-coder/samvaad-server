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

const superAdminCallAnalyticsListQuery = [
  ...optionalDateRangeQuery,
  query("hospitalId")
    .optional({ values: "falsy" })
    .isMongoId()
    .withMessage("hospitalId must be a valid MongoDB id"),
];

const superAdminCallAnalyticsDetailsQuery = [
  validObjectId("hospitalId"),
  ...optionalDateRangeQuery,
  ...paginationQuery,
];

const adminCallAnalyticsQuery = [
  ...optionalDateRangeQuery,
  ...paginationQuery,
];

module.exports = {
  superAdminCallAnalyticsListQuery,
  superAdminCallAnalyticsDetailsQuery,
  adminCallAnalyticsQuery,
};
