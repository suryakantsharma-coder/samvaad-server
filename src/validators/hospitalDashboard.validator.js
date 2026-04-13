const { query } = require('express-validator');

/** GET /api/dashboard/hospital-admin */
const ALLOWED_PRESETS = new Set([
  'last_7_days',
  'last7',
  'last_30_days',
  'last30',
  'this_month',
  'custom',
]);

const hospitalAdminDashboardQuery = [
  query('preset')
    .optional()
    .trim()
    .custom((v) => {
      if (v === undefined || v === null || v === '') return true;
      const n = String(v).toLowerCase().replace(/-/g, '_');
      if (!ALLOWED_PRESETS.has(n)) {
        throw new Error('preset must be last_7_days, last_30_days, this_month, or custom');
      }
      return true;
    }),
  query('from_date')
    .optional()
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('from_date must be YYYY-MM-DD (IST calendar day)'),
  query('to_date')
    .optional()
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('to_date must be YYYY-MM-DD (IST calendar day)'),
  query('start_date')
    .optional()
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('start_date must be YYYY-MM-DD'),
  query('end_date')
    .optional()
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('end_date must be YYYY-MM-DD'),
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
  hospitalAdminDashboardQuery,
};
