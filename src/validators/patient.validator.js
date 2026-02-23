const { body, query } = require('express-validator');
const { paginationQuery } = require('./common');

const createPatient = [
  body('fullName')
    .trim()
    .notEmpty()
    .withMessage('fullName is required')
    .isLength({ max: 200 })
    .withMessage('fullName must be at most 200 characters')
    .escape(),
  body('phoneNumber')
    .trim()
    .notEmpty()
    .withMessage('phoneNumber is required')
    .isLength({ max: 20 })
    .withMessage('phoneNumber must be at most 20 characters')
    .escape(),
  body('age')
    .isInt({ min: 0 })
    .withMessage('age must be a non-negative integer')
    .toInt(),
  body('gender')
    .trim()
    .notEmpty()
    .withMessage('gender is required')
    .isIn(['Male', 'Female', 'Other'])
    .withMessage('gender must be Male, Female, or Other')
    .escape(),
];

const updatePatient = [
  body('fullName')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('fullName cannot be empty')
    .isLength({ max: 200 })
    .withMessage('fullName must be at most 200 characters')
    .escape(),
  body('phoneNumber')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('phoneNumber cannot be empty')
    .isLength({ max: 20 })
    .withMessage('phoneNumber must be at most 20 characters')
    .escape(),
  body('age')
    .optional()
    .isInt({ min: 0 })
    .withMessage('age must be a non-negative integer')
    .toInt(),
  body('gender')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('gender cannot be empty')
    .isIn(['Male', 'Female', 'Other'])
    .withMessage('gender must be Male, Female, or Other')
    .escape(),
];

/** GET /api/patients list: filter (all|today|tomorrow), fromDate, toDate (ISO YYYY-MM-DD), plus pagination. today/tomorrow = patients with an appointment on that day. */
const patientListQuery = [
  ...paginationQuery,
  query('filter')
    .optional()
    .trim()
    .isIn(['all', 'today', 'tomorrow'])
    .withMessage('filter must be one of: all, today, tomorrow')
    .escape(),
  query('fromDate')
    .optional()
    .trim()
    .isISO8601()
    .withMessage('fromDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('toDate')
    .optional()
    .trim()
    .isISO8601()
    .withMessage('toDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
];

const searchPatientsQuery = [
  query('q')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('q must be at most 200 characters')
    .escape(),
  query('name')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('name must be at most 200 characters')
    .escape(),
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be between 1 and 100')
    .toInt(),
];

module.exports = {
  createPatient,
  updatePatient,
  patientListQuery,
  searchPatientsQuery,
};
