const express = require("express");
const { protect } = require("../middleware/auth");
const { requireHospitalLink } = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const { listPaymentsQuery, searchPaymentsQuery } = require("../validators/payment.validator");
const paymentController = require("../controllers/paymentController");

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink);

router.get("/search", searchPaymentsQuery, validate, paymentController.search);
router.get("/", listPaymentsQuery, validate, paymentController.listByHospital);

module.exports = router;
