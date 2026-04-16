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

/** GET /api/patients list: filter (all|today|tomorrow, IST calendar day), date range fromDate/toDate or startDate/endDate (ISO YYYY-MM-DD = IST day), optional doctorId, pagination. filter=today|tomorrow wins over date range; embedded appointments match the active slice (preset day or range). */
const patientListQuery = [
  ...paginationQuery,
  query('doctorId')
    .optional()
    .trim()
    .isMongoId()
    .withMessage('doctorId must be a valid MongoDB id'),
  query('filter')
    .optional()
    .trim()
    .isIn(['all', 'today', 'tomorrow'])
    .withMessage('filter must be one of: all, today, tomorrow')
    .escape(),
  query('fromDate')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('fromDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('toDate')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('toDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('startDate')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('startDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('endDate')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('endDate must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('from_date')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('from_date must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('to_date')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('to_date must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('start_date')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('start_date must be a valid ISO date (e.g. YYYY-MM-DD)')
    .escape(),
  query('end_date')
    .optional({ values: 'falsy' })
    .trim()
    .isISO8601()
    .withMessage('end_date must be a valid ISO date (e.g. YYYY-MM-DD)')
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
