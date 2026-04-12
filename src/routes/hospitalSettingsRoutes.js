const express = require('express');
const { protect } = require('../middleware/auth');
const { requireHospitalLink } = require('../middleware/roles');
const {
  requireHospitalSettingsManager,
  requireBootstrapHospitalSettingsAccess,
} = require('../middleware/hospitalSettingsAccess');
const { validate } = require('../middleware/validate');
const {
  bootstrapHospitalSettings,
  getHospitalSettingsMeQuery,
  createHospitalSettings,
  updateHospitalSettings,
} = require('../validators/hospitalSettings.validator');
const hospitalSettingsController = require('../controllers/hospitalSettingsController');

const router = express.Router();

router.use(protect);

/** Bootstrap settings for a hospital with none yet: admin/super_admin (body.hospitalId) or hospital_admin (own hospital). */
router.post(
  '/bootstrap',
  requireHospitalLink,
  requireBootstrapHospitalSettingsAccess,
  bootstrapHospitalSettings,
  validate,
  hospitalSettingsController.bootstrap
);

router.use(requireHospitalLink);
router.use(requireHospitalSettingsManager);

router.get('/me', getHospitalSettingsMeQuery, validate, hospitalSettingsController.getMe);
router.post('/', createHospitalSettings, validate, hospitalSettingsController.create);
router.patch('/me', updateHospitalSettings, validate, hospitalSettingsController.updateMe);

module.exports = router;
