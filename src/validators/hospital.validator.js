const { body } = require('express-validator');

/** PATCH /api/hospitals/:id — all fields optional */
const updateHospital = [
  body('name').optional().trim().notEmpty().withMessage('name cannot be empty').isLength({ max: 200 }).escape(),
  body('phoneCountryCode').optional().trim().isLength({ max: 10 }).escape(),
  body('phoneNumber').optional().trim().notEmpty().withMessage('phoneNumber cannot be empty').isLength({ max: 20 }).escape(),
  body('email').optional().trim().isEmail().withMessage('Invalid email').normalizeEmail(),
  body('contactPerson').optional().trim().isLength({ max: 200 }).escape(),
  body('registrationNumber').optional().trim().isLength({ max: 100 }).escape(),
  body('address').optional().trim().isLength({ max: 500 }).escape(),
  body('city').optional().trim().isLength({ max: 100 }).escape(),
  body('pincode').optional().trim().isLength({ max: 20 }).escape(),
  body('url').optional().trim().isLength({ max: 500 }).escape(),
  body('logoUrl').optional().trim().isLength({ max: 500 }).escape(),
];

module.exports = {
  updateHospital,
};
