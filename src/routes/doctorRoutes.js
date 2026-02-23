const express = require('express');
const { protect } = require('../middleware/auth');
const { requireAdmin, requireStaff, requireHospitalLink } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId, paginationQuery } = require('../validators/common');
const { searchDoctorsQuery } = require('../validators/doctor.validator');
const { createDoctor, updateDoctor } = require('../validators/doctor.validator');
const doctorController = require('../controllers/doctorController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink); // Hospital roles (doctor, hospital_admin) must have linked hospital; only see that hospital's data

// Doctor, hospital_admin, admin: read-only (hospital-scoped for doctor/hospital_admin)
router.get('/', requireStaff, paginationQuery, validate, doctorController.getAll);
router.get('/search', requireStaff, searchDoctorsQuery, validate, doctorController.searchByName);
router.get('/:id', requireStaff, validObjectId('id'), validate, doctorController.getById);

// hospital_admin, admin only: create, update, delete
router.post('/', requireAdmin, createDoctor, validate, doctorController.create);
router.patch('/:id', requireAdmin, validObjectId('id'), updateDoctor, validate, doctorController.update);
router.delete('/:id', requireAdmin, validObjectId('id'), validate, doctorController.remove);

module.exports = router;
