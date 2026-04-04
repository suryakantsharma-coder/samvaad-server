const express = require('express');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const prescriptionDotController = require('../controllers/prescription.controller');

const router = express.Router();

router.get(
  '/prescriptions/:id',
  validObjectId('id'),
  validate,
  prescriptionDotController.getPublicPrescriptionById,
);

module.exports = router;
