const express = require('express');
const { protect } = require('../middleware/auth');
const {
  requireAdmin,
  requireAdminOrOwnDoctorProfile,
  requireStaff,
  requireHospitalLink,
} = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId, paginationQuery } = require('../validators/common');
const {
  searchDoctorsQuery,
  doctorByEmailQuery,
} = require('../validators/doctor.validator');
const { createDoctor, updateDoctor } = require('../validators/doctor.validator');
const doctorController = require('../controllers/doctorController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink); // Hospital roles (doctor, hospital_admin) must have linked hospital; only see that hospital's data

/** GET /api/doctors/names — staff JWT: doctor vs admin scoping inside handler (no pagination). */
router.get('/names', requireStaff, doctorController.listDoctorNames);

// Doctor, hospital_admin, admin: read-only (hospital-scoped for doctor/hospital_admin)
router.get('/', requireStaff, paginationQuery, validate, doctorController.getAll);
router.get('/search', requireStaff, searchDoctorsQuery, validate, doctorController.searchByName);
router.get('/by-email', requireStaff, doctorByEmailQuery, validate, doctorController.getByEmail);
router.get(
  '/link-status',
  requireStaff,
  doctorByEmailQuery,
  validate,
  doctorController.getLinkStatusByEmail,
);
router.get('/:id', requireStaff, validObjectId('id'), validate, doctorController.getById);

// hospital_admin, admin only: create, update, delete
router.post('/', requireAdmin, createDoctor, validate, doctorController.create);
router.patch(
  '/:id',
  requireAdminOrOwnDoctorProfile,
  validObjectId('id'),
  updateDoctor,
  validate,
  doctorController.update,
);
router.delete('/:id', requireAdmin, validObjectId('id'), validate, doctorController.remove);

module.exports = router;
