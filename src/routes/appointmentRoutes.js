const express = require('express');
const { protect } = require('../middleware/auth');
const { requireAdmin, requireStaff, requireHospitalLink } = require('../middleware/roles');
const { validate } = require('../middleware/validate');
const { validObjectId, paginationQuery, searchQueryParam } = require('../validators/common');
const { createAppointment, updateAppointment, appointmentListQuery } = require('../validators/appointment.validator');
const appointmentController = require('../controllers/appointmentController');

const router = express.Router();

router.use(protect);
router.use(requireHospitalLink); // Hospital roles only see their linked hospital's data

// Doctor, hospital_admin, admin: list (with counts + filter + fromDate/toDate), search, get by id, update
router.get('/', requireStaff, appointmentListQuery, validate, appointmentController.getAll);
router.get('/search', requireStaff, searchQueryParam, validate, appointmentController.search);
router.get('/:id', requireStaff, validObjectId('id'), validate, appointmentController.getById);
router.patch('/:id', requireStaff, validObjectId('id'), updateAppointment, validate, appointmentController.update);

// Admin, hospital_admin only: create, delete
router.post('/', requireAdmin, createAppointment, validate, appointmentController.create);
router.delete('/:id', requireAdmin, validObjectId('id'), validate, appointmentController.remove);

module.exports = router;
