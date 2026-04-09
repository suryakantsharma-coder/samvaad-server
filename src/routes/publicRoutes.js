const express = require('express');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const { createMeetLinkBody } = require('../validators/googleMeet.validator');
const prescriptionDotController = require('../controllers/prescription.controller');
const publicGoogleMeetController = require('../controllers/publicGoogleMeet.controller');

const router = express.Router();

router.get(
  '/prescriptions/:id',
  validObjectId('id'),
  validate,
  prescriptionDotController.getPublicPrescriptionById,
);

/** Public Google Meet creation (Calendar API + OAuth). */
router.post(
  '/google-meet',
  createMeetLinkBody,
  validate,
  publicGoogleMeetController.createMeet,
);

module.exports = router;
