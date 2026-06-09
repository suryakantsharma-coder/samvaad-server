const express = require("express");
const { protect } = require("../middleware/auth");
const { requireExactRoles, ROLES } = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const {
  superAdminCallAnalyticsListQuery,
  superAdminCallAnalyticsDetailsQuery,
} = require("../validators/callAnalytics.validator");
const superAdminCallAnalyticsController = require("../controllers/superAdminCallAnalytics.controller");

const router = express.Router();

router.use(protect);
router.use(requireExactRoles(ROLES.SUPER_ADMIN));

router.get(
  "/call-analytics",
  superAdminCallAnalyticsListQuery,
  validate,
  superAdminCallAnalyticsController.listHospitalAnalytics
);

router.get(
  "/call-analytics/:hospitalId",
  superAdminCallAnalyticsDetailsQuery,
  validate,
  superAdminCallAnalyticsController.getHospitalAnalyticsDetails
);

module.exports = router;
