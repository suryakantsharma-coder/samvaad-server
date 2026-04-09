const { body } = require('express-validator');

const createPaymentTransaction = [
  body('patientId').trim().notEmpty().isMongoId().withMessage('patientId must be a valid Mongo ObjectId'),
  body('appointmentId').trim().notEmpty().isMongoId().withMessage('appointmentId must be a valid Mongo ObjectId'),
  body('hospitalId').trim().notEmpty().isMongoId().withMessage('hospitalId must be a valid Mongo ObjectId'),
  body('razorpay_payment_id').trim().notEmpty().withMessage('razorpay_payment_id is required'),
  body('razorpay_order_id').trim().notEmpty().withMessage('razorpay_order_id is required'),
  body('razorpay_signature').trim().notEmpty().withMessage('razorpay_signature is required'),
  body('consentAcknowledged')
    .optional()
    .isBoolean()
    .withMessage('consentAcknowledged must be boolean'),
  body('termsVersion')
    .optional()
    .trim()
    .isLength({ max: 64 })
    .withMessage('termsVersion must be at most 64 characters'),
  body('internalNotes')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('internalNotes must be at most 2000 characters'),
];

module.exports = {
  createPaymentTransaction,
};
