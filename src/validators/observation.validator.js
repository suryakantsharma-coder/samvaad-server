const { body, query } = require('express-validator');

const createObservation = [
  body('patientId').trim().isMongoId().withMessage('patientId must be a valid MongoDB id'),
  body('observations')
    .optional()
    .isArray()
    .withMessage('observations must be an array'),
  body('observations.*.text')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('observation text is required')
    .isLength({ max: 2000 })
    .withMessage('observation text must be at most 2000 characters'),
  body('observations.*.time')
    .optional()
    .isISO8601()
    .withMessage('observation time must be a valid ISO datetime')
    .toDate(),
];

const updateObservation = [
  body('observations')
    .isArray()
    .withMessage('observations must be an array'),
  body('observations.*.text')
    .trim()
    .notEmpty()
    .withMessage('observation text is required')
    .isLength({ max: 2000 })
    .withMessage('observation text must be at most 2000 characters'),
  body('observations.*.time')
    .optional()
    .isISO8601()
    .withMessage('observation time must be a valid ISO datetime')
    .toDate(),
];

const addObservationEntry = [
  body('text')
    .trim()
    .notEmpty()
    .withMessage('text is required')
    .isLength({ max: 2000 })
    .withMessage('text must be at most 2000 characters'),
  body('time')
    .optional()
    .isISO8601()
    .withMessage('time must be a valid ISO datetime')
    .toDate(),
];

const searchObservationQuery = [
  query('patientId')
    .trim()
    .isMongoId()
    .withMessage('patientId must be a valid MongoDB id'),
];

module.exports = {
  createObservation,
  updateObservation,
  addObservationEntry,
  searchObservationQuery,
};
