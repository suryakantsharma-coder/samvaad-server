const { body, query } = require('express-validator');
const mongoose = require('mongoose');
const { paginationQuery, searchQueryParam } = require('./common');

/** Accept patient or patientId (at least one required, valid MongoId). */
const patientIdOrPatient = body('patient')
  .optional()
  .custom((val, { req }) => {
    const id = val || req.body.patientId;
    if (!id) throw new Error('Patient is required (use patient or patientId)');
    if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('Invalid patient id');
    return true;
  });

/** Medicine: name required; dosage/duration can be string or { value, unit }; frequency optional (or derived from intake/time). */
const medicineValidator = [
  body('medicines')
    .isArray({ min: 1 })
    .withMessage('At least one medicine is required'),
  body('medicines.*.name')
    .trim()
    .notEmpty()
    .withMessage('Medicine name is required')
    .isLength({ max: 200 })
    .withMessage('Medicine name must be at most 200 characters')
    .escape(),
  body('medicines.*.dosage').optional({ values: 'null' }),
  body('medicines.*.frequency').optional({ values: 'null' }),
  body('medicines.*.duration').optional({ values: 'null' }),
];

const createPrescription = [
  patientIdOrPatient,
  body('appointmentId')
    .optional()
    .trim()
    .isMongoId()
    .withMessage('Invalid appointmentId'),
  ...medicineValidator,
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('notes must be at most 2000 characters')
    .escape(),
  body('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
];

const updatePrescription = [
  body('patientId').optional().trim().isMongoId().withMessage('Invalid patientId'),
  body('patient').optional().trim().isMongoId().withMessage('Invalid patient'),
  body('appointmentId').optional().trim().isMongoId().withMessage('Invalid appointmentId'),
  body('medicines')
    .optional()
    .isArray({ min: 1 })
    .withMessage('medicines must be a non-empty array'),
  body('medicines.*.name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Medicine name cannot be empty')
    .isLength({ max: 200 })
    .escape(),
  body('medicines.*.dosage').optional({ values: 'null' }),
  body('medicines.*.frequency').optional({ values: 'null' }),
  body('medicines.*.duration').optional({ values: 'null' }),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .escape(),
  body('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
];

/** GET /api/prescriptions list: page, limit, status */
const prescriptionListQuery = [
  ...paginationQuery,
  query('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
];

module.exports = {
  createPrescription,
  updatePrescription,
  prescriptionListQuery,
  searchQueryParam,
};
