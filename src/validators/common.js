const { param, query } = require("express-validator");
const mongoose = require("mongoose");

/** Validates MongoDB ObjectId in param (e.g. :id) */
const validObjectId = (paramName = "id") =>
  param(paramName)
    .notEmpty()
    .withMessage(`${paramName} is required`)
    .isMongoId()
    .withMessage(`Invalid ${paramName}`);

/** Pagination query params */
const paginationQuery = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer")
    .toInt(),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be between 1 and 100")
    .toInt(),
];

/** Search query param (q = search term; matches any searchable field) */
const searchQueryParam = [
  query("q")
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage("q must be at most 200 characters")
    .escape(),
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be a positive integer")
    .toInt(),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("limit must be between 1 and 100")
    .toInt(),
];

/** Validates ObjectId in body/query */
const validObjectIdBody = (field) =>
  require("express-validator")
    .body(field)
    .notEmpty()
    .withMessage(`${field} is required`)
    .isMongoId()
    .withMessage(`Invalid ${field}`);

module.exports = {
  validObjectId,
  paginationQuery,
  searchQueryParam,
  validObjectIdBody,
};
