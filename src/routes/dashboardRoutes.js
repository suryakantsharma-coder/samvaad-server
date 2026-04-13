const express = require('express');
const { protect } = require('../middleware/auth');
const { requireExactRoles, requireHospitalLink, ROLES } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { hospitalAdminDashboardQuery } = require('../validators/hospitalDashboard.validator');
const hospitalDashboardController = require('../controllers/hospitalDashboardController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink);
router.use(requireExactRoles(ROLES.HOSPITAL_ADMIN));

router.get(
  '/hospital-admin',
  hospitalAdminDashboardQuery,
  validate,
  hospitalDashboardController.getHospitalAdminDashboard
);

module.exports = router;
