const express = require('express');
const { protect } = require('../middleware/auth');
const { requireAdmin, requireStaff, requireHospitalLink } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const { createPatient, updatePatient, patientListQuery, searchPatientsQuery } = require('../validators/patient.validator');
const patientController = require('../controllers/patientController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink); // Hospital roles only see their linked hospital's data

// Doctor, hospital_admin, admin: list (with counts + filter + fromDate/toDate), search, get by id, update
router.get('/', requireStaff, patientListQuery, validate, patientController.getAll);
router.get('/search', requireStaff, searchPatientsQuery, validate, patientController.searchByName);
router.get('/:id/overview', requireStaff, validObjectId('id'), validate, patientController.getOverview);
router.get('/:id', requireStaff, validObjectId('id'), validate, patientController.getById);
router.patch('/:id', requireStaff, validObjectId('id'), updatePatient, validate, patientController.update);

// Admin, hospital_admin only: create, delete
router.post('/', requireAdmin, createPatient, validate, patientController.create);
router.delete('/:id', requireAdmin, validObjectId('id'), validate, patientController.remove);

module.exports = router;
