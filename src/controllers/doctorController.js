const Doctor = require('../models/doctor.model');
const User = require('../models/User');
const mongoose = require('mongoose');
const {
  mergeHospitalFilter,
  getLinkedHospitalForResponse,
  getHospitalFilter,
} = require('../utils/hospitalScope');
const { sanitizeAvailabilityForDisplay } = require('../utils/doctorAvailabilityText');
const { ROLES } = require('../constants/roles');
const {
  scheduleDoctorHolidayJobsFromDoc,
  syncDoctorHolidayJobs,
} = require('../services/doctorHolidayJobs.service');

/** Normalize availability for JSON (undo validator .escape() / double-encoded entities). */
function withNormalizedAvailability(doc) {
  if (!doc || typeof doc.availability !== 'string') return doc;
  const normalized = sanitizeAvailabilityForDisplay(doc.availability);
  return { ...doc, availability: normalized || doc.availability };
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Lookup doctor(s) by normalized email with the same hospital scoping as other doctor routes.
 * @returns {Promise<{ doctor: object }|{ error: number, message: string }>}
 */
async function findDoctorByEmailScoped(req, normalizedEmail) {
  const filter = { email: normalizedEmail };
  mergeHospitalFilter(req, filter);

  if (req.user.role !== ROLES.DOCTOR && !filter.hospital) {
    if (req.query.hospitalId && mongoose.isValidObjectId(String(req.query.hospitalId).trim())) {
      filter.hospital = String(req.query.hospitalId).trim();
    }
  }

  const doctors = await Doctor.find(filter)
    .populate('hospital', 'name registrationNumber city')
    .lean();

  if (!doctors.length) {
    return { error: 404, message: 'Doctor not found' };
  }
  if (doctors.length > 1) {
    return {
      error: 400,
      message: 'Multiple doctors match this email; pass hospitalId to narrow results',
    };
  }
  return { doctor: doctors[0] };
}

/**
 * @route GET /api/doctors/by-email?email=
 * Optional ?hospitalId= for platform admins when the email exists under more than one hospital.
 */
const getByEmail = async (req, res, next) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const outcome = await findDoctorByEmailScoped(req, email);
    if (outcome.error) {
      return res.status(outcome.error).json({ success: false, message: outcome.message });
    }
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { doctor: withNormalizedAvailability(outcome.doctor) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/doctors/link-status?email=
 * Hospital linkage (Doctor.hospital) and login linkage (User.doctorProfile).
 */
const getLinkStatusByEmail = async (req, res, next) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    const outcome = await findDoctorByEmailScoped(req, email);
    if (outcome.error) {
      return res.status(outcome.error).json({ success: false, message: outcome.message });
    }
    const doctor = outcome.doctor;
    const linkedUser = await User.findOne({ doctorProfile: doctor._id })
      .select('_id email name role isActive hospital doctorProfile')
      .lean();

    const hospitalId = doctor.hospital ? String(doctor.hospital._id || doctor.hospital) : null;

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        email: doctor.email,
        doctorRecordId: String(doctor._id),
        businessDoctorId: doctor.doctorId,
        linkedToHospital: Boolean(hospitalId),
        hospitalId,
        hospital: doctor.hospital || null,
        userAccountLinked: Boolean(linkedUser),
        user: linkedUser
          ? {
              _id: String(linkedUser._id),
              email: linkedUser.email,
              name: linkedUser.name,
              role: linkedUser.role,
              isActive: linkedUser.isActive,
              hospital: linkedUser.hospital ? String(linkedUser.hospital) : null,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/doctors/names
 * One endpoint for JWT staff: `doctor` → doctors in linked hospital only; `hospital_admin` / `admin` / `super_admin` → same hospital or all (optional ?hospitalId= for platform admin). No pagination.
 */
const listDoctorNames = async (req, res, next) => {
  try {
    const filter = {};
    const role = req.user.role;

    if (role === ROLES.DOCTOR) {
      mergeHospitalFilter(req, filter);
    } else {
      const scope = getHospitalFilter(req);
      if (scope.hospital) {
        filter.hospital = scope.hospital;
      } else if (req.query.hospitalId && mongoose.isValidObjectId(req.query.hospitalId)) {
        filter.hospital = req.query.hospitalId;
      }
    }

    const doctors = await Doctor.find(filter)
      .select('fullName')
      .sort({ fullName: 1 })
      .lean();

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        doctors: doctors.map((d) => ({ _id: d._id, fullName: d.fullName })),
      },
    });
  } catch (err) {
    next(err);
  }
};

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
        overall: {
          totalDoctors: total,
        },
        doctors: doctors.map(withNormalizedAvailability),
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
        doctors: doctors.map(withNormalizedAvailability),
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
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { doctor: withNormalizedAvailability(doctor) },
    });
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

    if (body.availability != null && typeof body.availability === 'string') {
      const n = sanitizeAvailabilityForDisplay(body.availability);
      body.availability = n || body.availability;
    }

    const doctorId = await generateDoctorId();
    const doctor = await Doctor.create({ ...body, doctorId, hospital: hospitalId });
    await scheduleDoctorHolidayJobsFromDoc(doctor);
    res.status(201).json({
      success: true,
      data: { doctor: withNormalizedAvailability(doctor.toObject()) },
    });
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

    if (req.user.role === ROLES.DOCTOR) {
      delete body.doctorId;
    }

    if (body.availability != null && typeof body.availability === 'string') {
      const n = sanitizeAvailabilityForDisplay(body.availability);
      body.availability = n || body.availability;
    }

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const previous = await Doctor.findOne(filter).select('holidays').lean();
    const previousHolidayIds = (previous?.holidays || [])
      .filter((h) => h && h._id)
      .map((h) => String(h._id));

    const doctor = await Doctor.findOneAndUpdate(filter, { $set: body }, {
      new: true,
      runValidators: true,
    });

    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    await syncDoctorHolidayJobs(doctor, previousHolidayIds);

    res.json({
      success: true,
      data: { doctor: withNormalizedAvailability(doctor.toObject()) },
    });
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
  listDoctorNames,
  getAll,
  searchByName,
  getByEmail,
  getLinkStatusByEmail,
  getById,
  create,
  update,
  remove,
};
