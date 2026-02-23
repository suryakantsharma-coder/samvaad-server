const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { requireAdmin, requireAdminOnly, requireHospitalLink } = require('../middleware/roles');
const { getHospitalFilter, getLinkedHospitalForResponse } = require('../utils/hospitalScope');
const { validate } = require('../middleware/validate');
const { validObjectId } = require('../validators/common');
const { body } = require('express-validator');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(protect);
router.use(requireAdmin);
router.use(requireHospitalLink);

/** GET /api/admin/users — list all users (admin: optional ?hospitalId=; hospital_admin: scoped to linked hospital) */
router.get('/users', async (req, res, next) => {
  try {
    const filter = {};
    const scope = getHospitalFilter(req);
    // Admin can filter by query param; hospital_admin is forced to their linked hospital
    if (scope.hospital) {
      filter.hospital = scope.hospital;
    } else if (req.query.hospitalId && mongoose.isValidObjectId(req.query.hospitalId)) {
      filter.hospital = req.query.hospitalId;
    }
    const users = await User.find(filter).select('-password').lean();
    res.json({ success: true, ...getLinkedHospitalForResponse(req), data: { users } });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/users/:id — update user role and/or hospital (admin only) */
const updateUserRole = [
  body('role')
    .optional()
    .trim()
    .isIn(Object.values(ROLES))
    .withMessage(`role must be one of: ${Object.values(ROLES).join(', ')}`)
    .escape(),
  body('hospitalId')
    .optional()
    .trim()
    .isMongoId()
    .withMessage('Invalid hospitalId'),
];

router.patch(
  '/users/:id',
  requireAdminOnly,
  validObjectId('id'),
  updateUserRole,
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const updateData = {};
      if (req.body.role !== undefined) updateData.role = req.body.role;
      if (req.body.hospitalId !== undefined) {
        updateData.hospital = req.body.hospitalId === '' ? undefined : req.body.hospitalId;
      }
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ success: false, message: 'Provide role and/or hospitalId to update' });
      }
      const user = await User.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: true })
        .select('-password')
        .lean();
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      res.json({ success: true, data: { user } });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
