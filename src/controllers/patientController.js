const Patient = require("../models/patient.model");
const Appointment = require("../models/appointment.model");
const Prescription = require("../models/prescription.model");
const { mergeHospitalFilter, getLinkedHospitalForResponse } = require("../utils/hospitalScope");

const DEFAULT_PAGE = 1;
const APPOINTMENT_POPULATE = { path: 'doctor', select: 'fullName doctorId designation' };
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function startOfDayUTC(d) {
  const date = new Date(d);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function endOfDayUTC(d) {
  const date = new Date(d);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function todayFilter() {
  return { $gte: startOfDayUTC(new Date()), $lte: endOfDayUTC(new Date()) };
}

function tomorrowFilter() {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + 1);
  return { $gte: startOfDayUTC(t), $lte: endOfDayUTC(t) };
}

/**
 * @route GET /api/patients
 * Query: filter=all|today|tomorrow, fromDate (YYYY-MM-DD), toDate (YYYY-MM-DD), page, limit.
 * today/tomorrow = patients who have an appointment on that day. fromDate-toDate = patients with appointment in range.
 * Response includes counts: { all, today, tomorrow }.
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    const skip = (page - 1) * limit;
    const filterChoice = (req.query.filter || 'all').toLowerCase();
    const fromDate = req.query.fromDate ? req.query.fromDate.trim() : null;
    const toDate = req.query.toDate ? req.query.toDate.trim() : null;

    const baseFilter = {};
    mergeHospitalFilter(req, baseFilter);

    const appointmentBaseFilter = {};
    mergeHospitalFilter(req, appointmentBaseFilter);

    const appointmentFilterToday = { ...appointmentBaseFilter, appointmentDateTime: todayFilter() };
    const appointmentFilterTomorrow = { ...appointmentBaseFilter, appointmentDateTime: tomorrowFilter() };

    const [countAll, totalAppointments, patientIdsToday, patientIdsTomorrow] = await Promise.all([
      Patient.countDocuments(baseFilter),
      Appointment.countDocuments(appointmentBaseFilter),
      Appointment.find(appointmentFilterToday).distinct('patient'),
      Appointment.find(appointmentFilterTomorrow).distinct('patient'),
    ]);

    const countToday = patientIdsToday.length;
    const countTomorrow = patientIdsTomorrow.length;

    const listFilter = { ...baseFilter };
    if (filterChoice === 'today') {
      listFilter._id = { $in: patientIdsToday };
    } else if (filterChoice === 'tomorrow') {
      listFilter._id = { $in: patientIdsTomorrow };
    } else if (fromDate || toDate) {
      const rangeFilter = { ...appointmentBaseFilter, appointmentDateTime: {} };
      if (fromDate) rangeFilter.appointmentDateTime.$gte = startOfDayUTC(fromDate);
      if (toDate) rangeFilter.appointmentDateTime.$lte = endOfDayUTC(toDate);
      const patientIdsInRange = await Appointment.find(rangeFilter).distinct('patient');
      listFilter._id = { $in: patientIdsInRange };
    }

    const [patients, total] = await Promise.all([
      Patient.find(listFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Patient.countDocuments(listFilter),
    ]);

    const patientIds = patients.map((p) => p._id);
    const appointmentFilter = patientIds.length ? { patient: { $in: patientIds } } : {};
    mergeHospitalFilter(req, appointmentFilter);
    const appointments = patientIds.length
      ? await Appointment.find(appointmentFilter)
          .populate(APPOINTMENT_POPULATE)
          .sort({ appointmentDateTime: -1 })
          .lean()
      : [];

    const appointmentsByPatient = appointments.reduce((acc, apt) => {
      const key = String(apt.patient);
      if (!acc[key]) acc[key] = [];
      acc[key].push(apt);
      return acc;
    }, {});

    const patientsWithAppointments = patients.map((p) => ({
      ...p,
      appointments: appointmentsByPatient[String(p._id)] || [],
    }));

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        overall: {
          totalPatients: countAll,
          totalAppointments,
        },
        counts: {
          all: countAll,
          today: countToday,
          tomorrow: countTomorrow,
        },
        patients: patientsWithAppointments,
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
 * @route GET /api/patients/search?q=... or ?name=...
 * Search patients: if q is provided, match any of fullName, patientId, phoneNumber, reason, gender; otherwise name matches fullName.
 */
const searchByName = async (req, res, next) => {
  try {
    const q = (req.query.q || req.query.name || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    if (q) {
      const regex = { $regex: q, $options: 'i' };
      filter.$or = [
        { fullName: regex },
        { patientId: regex },
        { phoneNumber: regex },
        { reason: regex },
        { gender: regex },
      ];
    }
    mergeHospitalFilter(req, filter);

    const [patients, total] = await Promise.all([
      Patient.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Patient.countDocuments(filter),
    ]);

    const patientIds = patients.map((p) => p._id);
    const appointmentFilter = patientIds.length ? { patient: { $in: patientIds } } : {};
    mergeHospitalFilter(req, appointmentFilter);
    const appointments = patientIds.length
      ? await Appointment.find(appointmentFilter)
          .populate(APPOINTMENT_POPULATE)
          .sort({ appointmentDateTime: -1 })
          .lean()
      : [];

    const appointmentsByPatient = appointments.reduce((acc, apt) => {
      const key = String(apt.patient);
      if (!acc[key]) acc[key] = [];
      acc[key].push(apt);
      return acc;
    }, {});

    const patientsWithAppointments = patients.map((p) => ({
      ...p,
      appointments: appointmentsByPatient[String(p._id)] || [],
    }));

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        patients: patientsWithAppointments,
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
 * @route GET /api/patients/:id/overview
 * Returns patient, appointments, and prescriptions for the given patient (hospital-scoped).
 */
const getOverview = async (req, res, next) => {
  try {
    const patientId = req.params.id;
    const query = { _id: patientId };
    mergeHospitalFilter(req, query);
    const patient = await Patient.findOne(query).lean();
    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: "Patient not found" });
    }
    const baseFilter = { patient: patientId };
    const aptFilter = { ...baseFilter };
    const rxFilter = { ...baseFilter };
    mergeHospitalFilter(req, aptFilter);
    mergeHospitalFilter(req, rxFilter);
    const [appointments, prescriptions] = await Promise.all([
      Appointment.find(aptFilter)
        .populate(APPOINTMENT_POPULATE)
        .sort({ appointmentDateTime: -1 })
        .lean(),
      Prescription.find(rxFilter)
        .populate("appointment", "appointmentId reason appointmentDateTime")
        .sort({ createdAt: -1 })
        .lean(),
    ]);
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { patient, appointments, prescriptions },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @route GET /api/patients/:id
 */
const getById = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    mergeHospitalFilter(req, query);
    const patient = await Patient.findOne(query).lean();
    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: "Patient not found" });
    }
    const aptFilter = { patient: req.params.id };
    mergeHospitalFilter(req, aptFilter);
    const appointments = await Appointment.find(aptFilter)
      .populate(APPOINTMENT_POPULATE)
      .sort({ appointmentDateTime: -1 })
      .lean();
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { patient: { ...patient, appointments } },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Generate unique patientId in format P-YYYY-000001 (e.g. P-2025-000001).
 */
const generatePatientId = async () => {
  const year = new Date().getFullYear();
  const prefix = `P-${year}-`;
  const last = await Patient.findOne({ patientId: new RegExp(`^${prefix}`) })
    .sort({ patientId: -1 })
    .select('patientId')
    .lean();
  const nextNum = last
    ? parseInt(last.patientId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, '0');
  return `${prefix}${suffix}`;
};

/**
 * @route POST /api/patients
 */
const create = async (req, res, next) => {
  try {
    const hospitalId = req.user && req.user.hospital;
    if (!hospitalId) {
      return res
        .status(400)
        .json({ success: false, message: "User is not linked to a hospital" });
    }
    const body = { ...req.body };
    delete body.hospital; // Never allow from request; always use req.user.hospital

    const patientId = await generatePatientId();
    const patient = await Patient.create({ ...body, patientId, hospital: hospitalId });
    res
      .status(201)
      .json({ success: true, data: { patient: patient.toObject() } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route PATCH /api/patients/:id
 */
const update = async (req, res, next) => {
  try {
    const body = { ...req.body };
    delete body.patientId; // Immutable; backend-generated
    delete body.hospital;

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const patient = await Patient.findOneAndUpdate(
      filter,
      { $set: body },
      { new: true, runValidators: true }
    ).lean();

    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: "Patient not found" });
    }

    res.json({ success: true, data: { patient } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route DELETE /api/patients/:id
 */
const remove = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const patient = await Patient.findOneAndDelete(filter);
    if (!patient) {
      return res
        .status(404)
        .json({ success: false, message: "Patient not found" });
    }
    res.json({ success: true, message: "Patient deleted successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAll,
  searchByName,
  getById,
  getOverview,
  create,
  update,
  remove,
};
