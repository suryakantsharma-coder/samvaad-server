const express = require('express');
const { protect } = require('../middleware/auth');
const { requireExactRoles, ROLES } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId, searchQueryParam } = require('../validators/common');
const { listMedicinesQuery, createMedicine, updateMedicine } = require('../validators/medicine.validator');
const medicineController = require('../controllers/medicineController');

const router = express.Router();

router.use(protect);

/** Any authenticated role */
router.get('/', listMedicinesQuery, validate, medicineController.getAll);
router.get('/search', searchQueryParam, validate, medicineController.search);
router.get('/:id', validObjectId('id'), validate, medicineController.getById);

/** Super admin only */
router.post(
  '/',
  requireExactRoles(ROLES.SUPER_ADMIN),
  createMedicine,
  validate,
  medicineController.create
);
router.patch(
  '/:id',
  requireExactRoles(ROLES.SUPER_ADMIN),
  validObjectId('id'),
  updateMedicine,
  validate,
  medicineController.update
);
router.delete(
  '/:id',
  requireExactRoles(ROLES.SUPER_ADMIN),
  validObjectId('id'),
  validate,
  medicineController.remove
);

module.exports = router;
