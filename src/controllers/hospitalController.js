const Hospital = require("../models/hospital.model");
const mongoose = require("mongoose");
const { getHospitalFilter, getLinkedHospitalForResponse } = require("../utils/hospitalScope");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ROLES = require("../constants/roles").ROLES;

/**
 * @route GET /api/hospitals
 * admin: returns all hospitals. hospital_admin: returns only their assigned hospital.
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    const scope = getHospitalFilter(req);
    if (scope.hospital) {
      filter._id = scope.hospital;
    }

    const [hospitals, total] = await Promise.all([
      Hospital.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Hospital.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        hospitals,
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
 * @route GET /api/hospitals/search?q=...
 * Search hospitals: match any of name, address, city, pincode, phoneNumber, email, contactPerson, registrationNumber.
 */
const search = async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    const scope = getHospitalFilter(req);
    if (scope.hospital) {
      filter._id = scope.hospital;
    }
    if (q) {
      const regex = { $regex: q, $options: 'i' };
      filter.$or = [
        { name: regex },
        { address: regex },
        { city: regex },
        { pincode: regex },
        { phoneNumber: regex },
        { email: regex },
        { contactPerson: regex },
        { registrationNumber: regex },
      ];
    }

    const [hospitals, total] = await Promise.all([
      Hospital.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Hospital.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        hospitals,
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
 * @route GET /api/hospitals/:id
 * admin: can get any hospital. hospital_admin: can only get their assigned hospital.
 */
const getById = async (req, res, next) => {
  try {
    const scope = getHospitalFilter(req);
    if (scope.hospital && String(scope.hospital) !== String(req.params.id)) {
      return res.status(403).json({ success: false, message: "You can only access your own hospital" });
    }
    const hospital = await Hospital.findById(req.params.id).lean();
    if (!hospital) {
      return res
        .status(404)
        .json({ success: false, message: "Hospital not found" });
    }
    res.json({ success: true, ...getLinkedHospitalForResponse(req), data: { hospital } });
  } catch (err) {
    next(err);
  }
};

/**
 * Build hospital payload from req (supports JSON body or multipart form-data).
 * If req.file is set (uploaded logo), logoUrl is set to /uploads/hospitals/filename.
 */
const buildHospitalPayload = (req) => {
  const body = { ...req.body };
  if (req.file && req.file.filename) {
    body.logoUrl = `/uploads/hospitals/${req.file.filename}`;
  }
  return body;
};

/**
 * @route POST /api/hospitals
 * Accepts JSON or multipart/form-data. Use field "logo" for photo upload (max 5MB; JPEG, PNG, GIF, WebP).
 */
const create = async (req, res, next) => {
  try {
    const payload = buildHospitalPayload(req);
    const hospital = await Hospital.create(payload);
    res
      .status(201)
      .json({ success: true, data: { hospital: hospital.toObject() } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Hospital with this email or registration number already exists",
      });
    }
    next(err);
  }
};

/**
 * @route PATCH /api/hospitals/:id
 * Accepts JSON or multipart/form-data. Use field "logo" to upload a new photo (max 5MB).
 * hospital_admin: can only update their own hospital.
 */
const update = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.HOSPITAL_ADMIN && req.user.hospital && mongoose.isValidObjectId(req.user.hospital)) {
      if (String(req.user.hospital) !== String(req.params.id)) {
        return res.status(403).json({ success: false, message: "You can only update your own hospital" });
      }
    }
    const payload = buildHospitalPayload(req);
    const hospital = await Hospital.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true }
    ).lean();

    if (!hospital) {
      return res
        .status(404)
        .json({ success: false, message: "Hospital not found" });
    }

    res.json({ success: true, data: { hospital } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Hospital with this email or registration number already exists",
      });
    }
    next(err);
  }
};

/**
 * @route DELETE /api/hospitals/:id
 * hospital_admin: can only delete their own hospital (admin can delete any).
 */
const remove = async (req, res, next) => {
  try {
    if (req.user.role === ROLES.HOSPITAL_ADMIN && req.user.hospital && mongoose.isValidObjectId(req.user.hospital)) {
      if (String(req.user.hospital) !== String(req.params.id)) {
        return res.status(403).json({ success: false, message: "You can only delete your own hospital" });
      }
    }
    const hospital = await Hospital.findByIdAndDelete(req.params.id);
    if (!hospital) {
      return res
        .status(404)
        .json({ success: false, message: "Hospital not found" });
    }
    res.json({ success: true, message: "Hospital deleted successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  getById,
  search,
  create,
  update,
  remove,
};

