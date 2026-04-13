const { body, query } = require('express-validator');

const createDoctor = [
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
  body('email')
    .trim()
    .notEmpty()
    .withMessage('email is required')
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail(),
  body('designation')
    .trim()
    .notEmpty()
    .withMessage('designation is required')
    .isLength({ max: 100 })
    .withMessage('designation must be at most 100 characters')
    .escape(),
  body('availability')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('availability must be at most 500 characters'),
  body('status')
    .optional()
    .trim()
    .isIn(['On Duty', 'On Break', 'Off Duty', 'On Leave'])
    .withMessage('status must be one of: On Duty, On Break, Off Duty, On Leave')
    .escape(),
  body('utilization')
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage('utilization must be between 0 and 100')
    .toInt(),
  body('profileImage')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('profileImage URL must be at most 500 characters'),
  body('holidays')
    .optional()
    .isArray()
    .withMessage('holidays must be an array')
    .custom((arr) => {
      if (!Array.isArray(arr)) return true;
      for (const item of arr) {
        if (!item || item.startDate == null || item.endDate == null) {
          throw new Error('Each holiday must have startDate and endDate');
        }
        const s = new Date(item.startDate);
        const e = new Date(item.endDate);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
          throw new Error('Invalid holiday startDate or endDate');
        }
        if (e < s) {
          throw new Error('Holiday endDate must be on or after startDate');
        }
      }
      return true;
    }),
];

const updateDoctor = [
  body('fullName')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('fullName cannot be empty')
    .isLength({ max: 200 })
    .withMessage('fullName must be at most 200 characters')
    .escape(),
  body('doctorId')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('doctorId cannot be empty')
    .isLength({ max: 50 })
    .withMessage('doctorId must be at most 50 characters')
    .escape(),
  body('phoneNumber')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('phoneNumber cannot be empty')
    .isLength({ max: 20 })
    .withMessage('phoneNumber must be at most 20 characters')
    .escape(),
  body('email')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('email cannot be empty')
    .isEmail()
    .withMessage('Invalid email format')
    .normalizeEmail(),
  body('designation')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('designation cannot be empty')
    .isLength({ max: 100 })
    .withMessage('designation must be at most 100 characters')
    .escape(),
  body('availability')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('availability must be at most 500 characters'),
  body('status')
    .optional()
    .trim()
    .isIn(['On Duty', 'On Break', 'Off Duty', 'On Leave'])
    .withMessage('status must be one of: On Duty, On Break, Off Duty, On Leave')
    .escape(),
  body('utilization')
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage('utilization must be between 0 and 100')
    .toInt(),
  body('profileImage')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('profileImage URL must be at most 500 characters'),
  body('holidays')
    .optional()
    .isArray()
    .withMessage('holidays must be an array')
    .custom((arr) => {
      if (!Array.isArray(arr)) return true;
      for (const item of arr) {
        if (!item || item.startDate == null || item.endDate == null) {
          throw new Error('Each holiday must have startDate and endDate');
        }
        const s = new Date(item.startDate);
        const e = new Date(item.endDate);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
          throw new Error('Invalid holiday startDate or endDate');
        }
        if (e < s) {
          throw new Error('Holiday endDate must be on or after startDate');
        }
      }
      return true;
    }),
];

const searchDoctorsQuery = [
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
  createDoctor,
  updateDoctor,
  searchDoctorsQuery,
};
