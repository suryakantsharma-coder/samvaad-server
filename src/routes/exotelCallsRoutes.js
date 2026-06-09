const express = require("express");
const { body, query } = require("express-validator");
const { protect } = require("../middleware/auth");
const { requireAdminOnly } = require("../middleware/roles");
const { validate } = require("../middleware/validate");
const exotelCallsController = require("../controllers/exotelCalls.controller");

const router = express.Router();

router.use(protect);
router.use(requireAdminOnly);

router.post("/sync/current-month", exotelCallsController.syncCurrentMonth);
router.post(
  "/sync/month",
  [
    body("year").isInt({ min: 2000, max: 2100 }).withMessage("year must be valid"),
    body("month").isInt({ min: 1, max: 12 }).withMessage("month must be between 1 and 12"),
    body("pageSize").optional().isInt({ min: 1, max: 100 }).withMessage("pageSize must be 1-100"),
  ],
  validate,
  exotelCallsController.syncByMonth
);

router.get(
  "/summary",
  [
    query("year").optional().isInt({ min: 2000, max: 2100 }),
    query("month").optional().isInt({ min: 1, max: 12 }),
  ],
  validate,
  exotelCallsController.getSummaryByMonth
);

router.post("/", exotelCallsController.createOne);
router.get("/", exotelCallsController.list);
router.get("/:id", exotelCallsController.getById);
router.patch("/:id", exotelCallsController.updateById);
router.delete("/:id", exotelCallsController.removeById);

module.exports = router;
