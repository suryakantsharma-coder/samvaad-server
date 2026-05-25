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
  body('extraNotes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('extraNotes must be at most 2000 characters')
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
  body('extraNotes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('extraNotes must be at most 2000 characters')
    .escape(),
  body('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
];

/** Shared: IST calendar-day range + dateBy (omit → appointment; created = record createdAt). */
const prescriptionDateRangeQuery = [
  query('dateBy')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(['created', 'appointment'])
    .withMessage('dateBy must be created or appointment')
    .escape(),
  query('date_by')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(['created', 'appointment'])
    .withMessage('date_by must be created or appointment')
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

/** GET /api/prescriptions list: page, limit, status; optional doctorEmail (Doctor.email); optional date range (IST day); dateBy omitted = appointment (visit date); dateBy=created = createdAt. */
const prescriptionListQuery = [
  ...paginationQuery,
  query('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
  query('doctorEmail')
    .optional({ values: 'falsy' })
    .trim()
    .isEmail()
    .withMessage('doctorEmail must be a valid email'),
  query('doctor_email')
    .optional({ values: 'falsy' })
    .trim()
    .isEmail()
    .withMessage('doctor_email must be a valid email'),
  ...prescriptionDateRangeQuery,
];

/** GET /api/prescriptions/search — q matches notes, patientName, medicines, or linked patient fullName/patientId; optional doctorEmail; optional status + date range like list. */
const prescriptionSearchQuery = [
  query('q')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('q must be at most 200 characters')
    .escape(),
  ...paginationQuery,
  query('status')
    .optional()
    .trim()
    .isIn(['Draft', 'Completed', 'Cancelled'])
    .withMessage('status must be one of: Draft, Completed, Cancelled')
    .escape(),
  query('doctorEmail')
    .optional({ values: 'falsy' })
    .trim()
    .isEmail()
    .withMessage('doctorEmail must be a valid email'),
  query('doctor_email')
    .optional({ values: 'falsy' })
    .trim()
    .isEmail()
    .withMessage('doctor_email must be a valid email'),
  ...prescriptionDateRangeQuery,
];

module.exports = {
  createPrescription,
  updatePrescription,
  prescriptionListQuery,
  prescriptionSearchQuery,
  searchQueryParam,
};
