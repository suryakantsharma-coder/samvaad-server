const express = require('express');
const { protect } = require('../middleware/auth');
const {
  requireExactRoles,
  requireHospitalLink,
  ROLES,
} = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const { createPaymentTransaction } = require('../validators/teleCaller.validator');
const teleCallerController = require('../controllers/teleCallerController');

const router = express.Router();

const teleCallerAccess = requireExactRoles(
  ROLES.TELE_CALLER,
  ROLES.HOSPITAL_ADMIN,
  ROLES.ADMIN,
  ROLES.SUPER_ADMIN
);

/** Public: no auth — hospital filter is not applied (lookup by patient id only). */
router.get(
  '/patients/:patientId',
  validObjectId('patientId'),
  validate,
  teleCallerController.getPatientWithHospital
);

router.use(protect);
router.use(teleCallerAccess);
router.use(requireHospitalLink);

router.post(
  '/transactions',
  createPaymentTransaction,
  validate,
  teleCallerController.createPaymentTransaction
);

module.exports = router;
