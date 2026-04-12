const express = require('express');
const { protect } = require('../middleware/auth');
const { requireStaff, requireHospitalLink } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const {
  createPrescription,
  updatePrescription,
  prescriptionListQuery,
  prescriptionSearchQuery,
} = require('../validators/prescription.validator');
const prescriptionController = require('../controllers/prescriptionController');
const prescriptionDotController = require('../controllers/prescription.controller');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink);

// List (with filters), search, get by id, update
router.get('/', requireStaff, prescriptionListQuery, validate, prescriptionController.getAll);
router.get('/search', requireStaff, prescriptionSearchQuery, validate, prescriptionController.search);
router.get(
  '/reminders/dashboard',
  requireStaff,
  prescriptionDotController.getReminderQueueDashboard,
);
router.post(
  '/:id/schedule-reminders',
  requireStaff,
  validObjectId('id'),
  validate,
  prescriptionDotController.scheduleRemindersForPrescription,
);
router.get('/:id', requireStaff, validObjectId('id'), validate, prescriptionController.getById);
router.patch('/:id', requireStaff, validObjectId('id'), updatePrescription, validate, prescriptionController.update);

// Create, delete
router.post('/', requireStaff, createPrescription, validate, prescriptionController.create);
router.delete('/:id', requireStaff, validObjectId('id'), validate, prescriptionController.remove);

module.exports = router;
