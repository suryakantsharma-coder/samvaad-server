const express = require("express");
const { protect } = require("../middleware/auth");
const {
  requireHospitalLink,
  requireRoles,
  requireExactRoles,
  ROLES,
} = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const {
  listPayoutsQuery,
  searchPayoutsQuery,
  patchPayoutTransactionStatus,
  patchPayoutListStatus,
  searchPayoutTransactionsQuery,
} = require("../validators/payout.validator");
const payoutListController = require("../controllers/payoutListController");
const payoutSuperAdminController = require("../controllers/payoutSuperAdminController");

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink);

router.get(
  "/transactions/search",
  requireExactRoles(ROLES.SUPER_ADMIN),
  searchPayoutTransactionsQuery,
  validate,
  payoutSuperAdminController.searchTransactions
);

router.patch(
  "/transactions/:id/status",
  requireExactRoles(ROLES.SUPER_ADMIN),
  patchPayoutTransactionStatus,
  validate,
  payoutSuperAdminController.patchTransactionStatus
);

router.patch(
  "/list/:id/status",
  requireExactRoles(ROLES.SUPER_ADMIN),
  patchPayoutListStatus,
  validate,
  payoutSuperAdminController.patchPayoutListRecordStatus
);

router.get(
  "/search",
  requireRoles(
    ROLES.SUPER_ADMIN,
    ROLES.ADMIN,
    ROLES.HOSPITAL_ADMIN,
    ROLES.TELE_CALLER
  ),
  searchPayoutsQuery,
  validate,
  payoutListController.search
);

router.get(
  "/",
  requireRoles(
    ROLES.SUPER_ADMIN,
    ROLES.ADMIN,
    ROLES.HOSPITAL_ADMIN,
    ROLES.TELE_CALLER
  ),
  listPayoutsQuery,
  validate,
  payoutListController.list
);

module.exports = router;
