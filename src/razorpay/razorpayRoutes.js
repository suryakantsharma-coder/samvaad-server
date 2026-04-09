const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const razorpayController = require('./razorpayController');

const router = express.Router();

const createOrderRules = [
  body('amount')
    .notEmpty()
    .withMessage('amount is required')
    .isInt({ min: 1 })
    .withMessage('amount must be a positive integer (paise, e.g. 100000 for ₹1000)'),
  body('currency').optional().trim().isLength({ min: 3, max: 3 }).withMessage('currency must be 3 letters'),
  body('receipt').optional().trim().isLength({ max: 40 }).withMessage('receipt must be at most 40 characters'),
];

const verifyPaymentRules = [
  body('razorpay_order_id').trim().notEmpty().withMessage('razorpay_order_id is required'),
  body('razorpay_payment_id').trim().notEmpty().withMessage('razorpay_payment_id is required'),
  body('razorpay_signature').trim().notEmpty().withMessage('razorpay_signature is required'),
];

router.get('/webhook-info', razorpayController.webhookInfo);
router.post('/create-order', createOrderRules, validate, razorpayController.createOrder);
router.post('/verify-payment', verifyPaymentRules, validate, razorpayController.verifyPayment);
router.post('/webhook', razorpayController.webhook);

module.exports = router;
