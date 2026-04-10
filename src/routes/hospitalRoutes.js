const express = require('express');
const { protect } = require('../middleware/auth');
const {
  requireAdmin,
  requireAdminOnly,
  requireHospitalLink,
  requireGoogleCalendarHospitalAccess,
} = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId, paginationQuery, searchQueryParam } = require('../validators/common');
const { optionalHospitalLogo } = require('../middleware/upload');
const { updateHospital } = require('../validators/hospital.validator');
const hospitalController = require('../controllers/hospitalController');
const hospitalGoogleCalendarController = require('../controllers/hospitalGoogleCalendarController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink); // hospital_admin must have linked hospital to GET/PATCH their hospital

router.get(
  '/:hospitalId/google-calendar/status',
  validObjectId('hospitalId'),
  validate,
  requireGoogleCalendarHospitalAccess,
  hospitalGoogleCalendarController.getStatus,
);
router.get(
  '/:hospitalId/google-calendar/auth-url',
  validObjectId('hospitalId'),
  validate,
  requireGoogleCalendarHospitalAccess,
  hospitalGoogleCalendarController.getAuthUrl,
);

// GET: admin (all) or hospital_admin (own only). POST/DELETE: admin only.
router.get('/', requireAdmin, paginationQuery, validate, hospitalController.getAll);
router.get('/search', requireAdmin, searchQueryParam, validate, hospitalController.search);
router.get('/:id', requireAdmin, validObjectId('id'), validate, hospitalController.getById);
router.post('/', requireAdminOnly, optionalHospitalLogo, validate, hospitalController.create);
router.patch('/:id', requireAdmin, validObjectId('id'), optionalHospitalLogo, updateHospital, validate, hospitalController.update);
router.delete('/:id', requireAdminOnly, validObjectId('id'), validate, hospitalController.remove);

module.exports = router;

