const { body, query } = require('express-validator');
const { paginationQuery } = require('./common');

/** GET /api/medicines — pagination + optional type filter (case-insensitive substring on `type`). */
const listMedicinesQuery = [
  ...paginationQuery,
  query('type')
    .optional()
    .trim()
    .isLength({ max: 120 })
    .withMessage('type query must be at most 120 characters'),
];

const createMedicine = [
  body('medicineName')
    .trim()
    .notEmpty()
    .withMessage('medicineName is required')
    .isLength({ max: 300 })
    .withMessage('medicineName must be at most 300 characters'),
  body('type')
    .trim()
    .notEmpty()
    .withMessage('type is required')
    .isLength({ max: 120 })
    .withMessage('type must be at most 120 characters'),
  body('unit')
    .trim()
    .notEmpty()
    .withMessage('unit is required')
    .isLength({ max: 80 })
    .withMessage('unit must be at most 80 characters'),
];

const updateMedicine = [
  body('medicineName')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('medicineName cannot be empty')
    .isLength({ max: 300 })
    .withMessage('medicineName must be at most 300 characters'),
  body('type')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('type cannot be empty')
    .isLength({ max: 120 })
    .withMessage('type must be at most 120 characters'),
  body('unit')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('unit cannot be empty')
    .isLength({ max: 80 })
    .withMessage('unit must be at most 80 characters'),
];

module.exports = {
  listMedicinesQuery,
  createMedicine,
  updateMedicine,
};
