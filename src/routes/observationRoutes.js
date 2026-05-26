const express = require('express');
const { protect } = require('../middleware/auth');
const { requireExactRoles, requireHospitalLink, ROLES } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const {
  createObservation,
  updateObservation,
  addObservationEntry,
  searchObservationQuery,
} = require('../validators/observation.validator');
const observationController = require('../controllers/observationController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink);
router.use(requireExactRoles(ROLES.ADMIN, ROLES.DOCTOR));

router.get('/search', searchObservationQuery, validate, observationController.searchByPatientId);
router.post('/', createObservation, validate, observationController.create);
router.patch('/:id', validObjectId('id'), updateObservation, validate, observationController.update);
router.post(
  '/:id/entries',
  validObjectId('id'),
  addObservationEntry,
  validate,
  observationController.addEntry
);
router.delete('/:id', validObjectId('id'), validate, observationController.remove);

module.exports = router;
