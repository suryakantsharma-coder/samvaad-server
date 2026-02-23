const Doctor = require('../models/doctor.model');
const mongoose = require('mongoose');
const { mergeHospitalFilter, getLinkedHospitalForResponse } = require('../utils/hospitalScope');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @route GET /api/doctors
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    mergeHospitalFilter(req, filter);

    const [doctors, total] = await Promise.all([
      Doctor.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Doctor.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        doctors,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/doctors/search?q=... or ?name=...
 * Search doctors: if q is provided, match any of fullName, doctorId, phoneNumber, email, designation, availability, status; otherwise name matches fullName.
 */
const searchByName = async (req, res, next) => {
  try {
    const q = (req.query.q || req.query.name || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    if (q) {
      const regex = { $regex: q, $options: 'i' };
      filter.$or = [
        { fullName: regex },
        { doctorId: regex },
        { phoneNumber: regex },
        { email: regex },
        { designation: regex },
        { availability: regex },
        { status: regex },
      ];
    }
    mergeHospitalFilter(req, filter);

    const [doctors, total] = await Promise.all([
      Doctor.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Doctor.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        doctors,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/doctors/:id
 */
const getById = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    mergeHospitalFilter(req, query);
    const doctor = await Doctor.findOne(query).lean();
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }
    res.json({ success: true, ...getLinkedHospitalForResponse(req), data: { doctor } });
  } catch (err) {
    next(err);
  }
};

/**
 * Generate unique doctorId in format MD-YYYY-XXXXXX (e.g. MD-2024-156789).
 */
const generateDoctorId = async () => {
  const year = new Date().getFullYear();
  const prefix = `MD-${year}-`;
  const last = await Doctor.findOne({ doctorId: new RegExp(`^${prefix}`) })
    .sort({ doctorId: -1 })
    .select('doctorId')
    .lean();
  const nextNum = last
    ? parseInt(last.doctorId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, '0');
  return `${prefix}${suffix}`;
};

/**
 * @route POST /api/doctors
 */
const create = async (req, res, next) => {
  try {
    const hospitalId = req.user && req.user.hospital;
    if (!hospitalId) {
      return res.status(400).json({ success: false, message: 'User is not linked to a hospital' });
    }
    const body = { ...req.body };
    delete body.hospital; // Never allow from request; always use req.user.hospital

    const doctorId = await generateDoctorId();
    const doctor = await Doctor.create({ ...body, doctorId, hospital: hospitalId });
    res.status(201).json({ success: true, data: { doctor: doctor.toObject() } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Doctor with this email already exists',
      });
    }
    next(err);
  }
};

/**
 * @route PATCH /api/doctors/:id
 */
const update = async (req, res, next) => {
  try {
    const body = { ...req.body };
    delete body.hospital;

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const doctor = await Doctor.findOneAndUpdate(
      filter,
      { $set: body },
      { new: true, runValidators: true }
    ).lean();

    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    res.json({ success: true, data: { doctor } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Doctor with this doctorId or email already exists',
      });
    }
    next(err);
  }
};

/**
 * @route DELETE /api/doctors/:id
 */
const remove = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const doctor = await Doctor.findOneAndDelete(filter);
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }
    res.json({ success: true, message: 'Doctor deleted successfully' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  searchByName,
  getById,
  create,
  update,
  remove,
};
