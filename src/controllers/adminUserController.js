const mongoose = require('mongoose');
const User = require('../models/User');
const Doctor = require('../models/doctor.model');
const { ROLES } = require('../constants/roles');
const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');

const DOCTOR_PROFILE_SELECT = 'fullName doctorId designation email phoneNumber hospital';

/**
 * POST /api/admin/users/:id/link-doctor
 * Body: { doctorId: string } to link, or { doctorId: null } to unlink.
 * Target user must have role `doctor`. User and doctor must belong to the same hospital.
 */
const linkUserToDoctor = async (req, res, next) => {
  try {
    const { id: userId } = req.params;
    const { doctorId } = req.body;

    const userFilter = { _id: userId };
    if (req.user.role === ROLES.HOSPITAL_ADMIN || req.user.role === ROLES.DOCTOR) {
      userFilter.hospital = req.user.hospital;
    }

    const targetUser = await User.findOne(userFilter).select('-password').lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (targetUser.role !== ROLES.DOCTOR) {
      return res.status(400).json({
        success: false,
        message: 'Only users with the doctor role can be linked to a doctor profile',
      });
    }

    if (doctorId === null || doctorId === '') {
      const updated = await User.findOneAndUpdate(
        userFilter,
        { $unset: { doctorProfile: '' } },
        { new: true, runValidators: true },
      )
        .select('-password')
        .populate('doctorProfile', DOCTOR_PROFILE_SELECT)
        .lean();

      return res.json({
        success: true,
        ...getLinkedHospitalForResponse(req),
        data: { user: updated },
      });
    }

    if (!mongoose.isValidObjectId(String(doctorId))) {
      return res.status(400).json({ success: false, message: 'Invalid doctorId' });
    }

    const doctor = await Doctor.findById(doctorId).lean();
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    if (req.user.role === ROLES.HOSPITAL_ADMIN || req.user.role === ROLES.DOCTOR) {
      if (!doctor.hospital || String(doctor.hospital) !== String(req.user.hospital)) {
        return res.status(403).json({
          success: false,
          message: 'You can only link to a doctor profile in your hospital',
        });
      }
    }

    if (!targetUser.hospital || !doctor.hospital) {
      return res.status(400).json({
        success: false,
        message: 'Both the user and the doctor must belong to a hospital before linking',
      });
    }

    if (String(targetUser.hospital) !== String(doctor.hospital)) {
      return res.status(400).json({
        success: false,
        message: 'User and doctor must belong to the same hospital',
      });
    }

    const taken = await User.findOne({
      doctorProfile: doctorId,
      _id: { $ne: userId },
    })
      .select('_id email')
      .lean();
    if (taken) {
      return res.status(409).json({
        success: false,
        message: 'This doctor profile is already linked to another user account',
      });
    }

    const updated = await User.findOneAndUpdate(
      userFilter,
      { $set: { doctorProfile: doctorId } },
      { new: true, runValidators: true },
    )
      .select('-password')
      .populate('doctorProfile', DOCTOR_PROFILE_SELECT)
      .lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { user: updated },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This doctor profile is already linked to another user account',
      });
    }
    next(err);
  }
};

module.exports = {
  linkUserToDoctor,
};
