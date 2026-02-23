const Appointment = require('../models/appointment.model');
const Doctor = require('../models/doctor.model');
const Patient = require('../models/patient.model');
const mongoose = require('mongoose');
const { mergeHospitalFilter, getLinkedHospitalForResponse, getHospitalFilter } = require('../utils/hospitalScope');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Start of day UTC (00:00:00.000) for a given date */
function startOfDayUTC(d) {
  const date = new Date(d);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** End of day UTC (23:59:59.999) for a given date */
function endOfDayUTC(d) {
  const date = new Date(d);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

/** Get appointmentDateTime filter for today (UTC day) */
function todayFilter() {
  const start = startOfDayUTC(new Date());
  const end = endOfDayUTC(new Date());
  return { $gte: start, $lte: end };
}

/** Get appointmentDateTime filter for tomorrow (UTC day) */
function tomorrowFilter() {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + 1);
  const start = startOfDayUTC(t);
  const end = endOfDayUTC(t);
  return { $gte: start, $lte: end };
}

/**
 * @route GET /api/appointments
 * Query: filter=all|today|tomorrow, fromDate (YYYY-MM-DD), toDate (YYYY-MM-DD), doctorId, patientId, status, page, limit.
 * Response includes counts: { all, today, tomorrow }.
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const filterChoice = (req.query.filter || 'all').toLowerCase();
    const fromDate = req.query.fromDate ? req.query.fromDate.trim() : null;
    const toDate = req.query.toDate ? req.query.toDate.trim() : null;

    const baseFilter = {};
    if (req.query.doctorId && mongoose.isValidObjectId(req.query.doctorId)) {
      baseFilter.doctor = req.query.doctorId;
    }
    if (req.query.patientId && mongoose.isValidObjectId(req.query.patientId)) {
      baseFilter.patient = req.query.patientId;
    }
    if (req.query.status) {
      baseFilter.status = req.query.status;
    }
    mergeHospitalFilter(req, baseFilter);

    // Overall totals (hospital-scoped) and counts for today/tomorrow
    const patientBaseFilter = {};
    mergeHospitalFilter(req, patientBaseFilter);
    const filterToday = { ...baseFilter, appointmentDateTime: todayFilter() };
    const filterTomorrow = { ...baseFilter, appointmentDateTime: tomorrowFilter() };
    const [countAll, totalPatients, countToday, countTomorrow] = await Promise.all([
      Appointment.countDocuments(baseFilter),
      Patient.countDocuments(patientBaseFilter),
      Appointment.countDocuments(filterToday),
      Appointment.countDocuments(filterTomorrow),
    ]);

    // Apply date filter to the list
    const listFilter = { ...baseFilter };
    if (filterChoice === 'today') {
      listFilter.appointmentDateTime = todayFilter();
    } else if (filterChoice === 'tomorrow') {
      listFilter.appointmentDateTime = tomorrowFilter();
    } else if (fromDate || toDate) {
      listFilter.appointmentDateTime = {};
      if (fromDate) {
        listFilter.appointmentDateTime.$gte = startOfDayUTC(fromDate);
      }
      if (toDate) {
        listFilter.appointmentDateTime.$lte = endOfDayUTC(toDate);
      }
    }

    const [appointments, total] = await Promise.all([
      Appointment.find(listFilter)
        .populate('doctor', 'fullName doctorId designation')
        .populate('patient', 'fullName patientId phoneNumber age gender')
        .sort({ appointmentDateTime: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(listFilter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        overall: {
          totalAppointments: countAll,
          totalPatients,
        },
        counts: {
          all: countAll,
          today: countToday,
          tomorrow: countTomorrow,
        },
        appointments,
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
 * @route GET /api/appointments/search?q=...
 * Search appointments: match any of appointmentId, reason, status, type, or patient name/patientId, or doctor name/doctorId.
 */
const search = async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    mergeHospitalFilter(req, filter);

    if (q) {
      const regex = { $regex: q, $options: 'i' };
      const orClause = [
        { appointmentId: regex },
        { reason: regex },
        { status: regex },
        { type: regex },
      ];
      const patientFilter = {};
      const doctorFilter = {};
      mergeHospitalFilter(req, patientFilter);
      mergeHospitalFilter(req, doctorFilter);
      const [patientIds, doctorIds] = await Promise.all([
        Patient.find({ ...patientFilter, $or: [{ fullName: regex }, { patientId: regex }] }).distinct('_id'),
        Doctor.find({ ...doctorFilter, $or: [{ fullName: regex }, { doctorId: regex }] }).distinct('_id'),
      ]);
      if (patientIds.length) orClause.push({ patient: { $in: patientIds } });
      if (doctorIds.length) orClause.push({ doctor: { $in: doctorIds } });
      filter.$or = orClause;
    }

    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('doctor', 'fullName doctorId designation')
        .populate('patient', 'fullName patientId phoneNumber age gender')
        .sort({ appointmentDateTime: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        appointments,
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
 * @route GET /api/appointments/:id
 */
const getById = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    mergeHospitalFilter(req, query);

    const appointment = await Appointment.findOne(query)
      .populate('doctor', 'fullName doctorId designation email phoneNumber')
      .populate('patient', 'fullName patientId phoneNumber age gender')
      .lean();

    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    res.json({ success: true, ...getLinkedHospitalForResponse(req), data: { appointment } });
  } catch (err) {
    next(err);
  }
};

/**
 * Generate unique appointmentId in format A-YYYY-000001 (e.g. A-2025-000001).
 */
const generateAppointmentId = async () => {
  const year = new Date().getFullYear();
  const prefix = `A-${year}-`;
  const last = await Appointment.findOne({ appointmentId: new RegExp(`^${prefix}`) })
    .sort({ appointmentId: -1 })
    .select('appointmentId')
    .lean();
  const nextNum = last
    ? parseInt(last.appointmentId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, '0');
  return `${prefix}${suffix}`;
};

/**
 * @route POST /api/appointments
 */
const create = async (req, res, next) => {
  try {
    const [doctorExists, patientExists] = await Promise.all([
      Doctor.findById(req.body.doctor).lean(),
      Patient.findById(req.body.patient).lean(),
    ]);

    if (!doctorExists) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }
    if (!patientExists) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    // Ensure doctor and patient belong to the same hospital (if set)
    if (doctorExists.hospital && patientExists.hospital && !doctorExists.hospital.equals(patientExists.hospital)) {
      return res.status(400).json({ success: false, message: 'Doctor and patient must belong to the same hospital' });
    }

    const scope = getHospitalFilter(req);
    const linkedHospitalId = scope.hospital || null;

    // hospital_admin and doctor may only create appointments for their linked hospital
    if (linkedHospitalId) {
      const docHospital = doctorExists.hospital ? String(doctorExists.hospital) : null;
      const patHospital = patientExists.hospital ? String(patientExists.hospital) : null;
      const linked = String(linkedHospitalId);
      if ((docHospital && docHospital !== linked) || (patHospital && patHospital !== linked)) {
        return res.status(403).json({
          success: false,
          message: 'You can only create appointments for doctors and patients in your linked hospital',
        });
      }
    }

    const hospitalId =
      (doctorExists && doctorExists.hospital) ||
      (patientExists && patientExists.hospital) ||
      (req.user && req.user.hospital);

    if (!hospitalId) {
      return res.status(400).json({ success: false, message: 'Hospital context is required to create an appointment' });
    }

    const body = { ...req.body };
    delete body.appointmentId; // Always server-generated
    delete body.hospital; // Always derived from doctor/patient/user context

    const appointmentId = await generateAppointmentId();
    const appointment = await Appointment.create({ ...body, appointmentId, hospital: hospitalId });
    const populated = await Appointment.findById(appointment._id)
      .populate('doctor', 'fullName doctorId designation')
      .populate('patient', 'fullName patientId phoneNumber age gender')
      .lean();

    res.status(201).json({ success: true, data: { appointment: populated } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route PATCH /api/appointments/:id
 */
const update = async (req, res, next) => {
  try {
    const updateData = { ...req.body };
    delete updateData.appointmentId; // Immutable; backend-generated
    delete updateData.hospital; // Immutable; derived from doctor/patient

    if (updateData.doctor) {
      const doctorExists = await Doctor.findById(updateData.doctor).lean();
      if (!doctorExists) {
        return res.status(404).json({ success: false, message: 'Doctor not found' });
      }
    }
    if (updateData.patient) {
      const patientExists = await Patient.findById(updateData.patient).lean();
      if (!patientExists) {
        return res.status(404).json({ success: false, message: 'Patient not found' });
      }
    }

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const appointment = await Appointment.findOneAndUpdate(
      filter,
      { $set: updateData },
      { new: true, runValidators: true }
    )
      .populate('doctor', 'fullName doctorId designation')
      .populate('patient', 'fullName patientId phoneNumber age gender')
      .lean();

    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    res.json({ success: true, data: { appointment } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route DELETE /api/appointments/:id
 */
const remove = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const appointment = await Appointment.findOneAndDelete(filter);
    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }
    res.json({ success: true, message: 'Appointment deleted successfully' });
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
