const mongoose = require("mongoose");
const Patient = require("../models/patient.model");
const Appointment = require("../models/appointment.model");
const Prescription = require("../models/prescription.model");
const { mergeHospitalFilter, getLinkedHospitalForResponse } = require("../utils/hospitalScope");
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  istTodayRange,
  istTomorrowRange,
} = require("../utils/queryDateRange");

const DEFAULT_PAGE = 1;
const APPOINTMENT_POPULATE = { path: 'doctor', select: 'fullName doctorId designation' };
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @route GET /api/patients
 * Query: filter=all|today|tomorrow; date range fromDate/toDate, startDate/endDate, or snake_case (YYYY-MM-DD = IST day);
 * optional doctorId; page, limit. filter=today|tomorrow wins over date range for listing (UI often sends both).
 * With filter=all, date range limits to patients who have an appointment in that window. doctorId scopes appointments.
 * Response counts.today / counts.tomorrow stay calendar chips; counts.inRange when a range is applied (not with preset filter).
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
    const usePresetDayFilter = filterChoice === 'today' || filterChoice === 'tomorrow';

    const { fromDate, toDate, hasDateRange: rangeParamsPresent } = getDateRangeFromQuery(req.query);

    const doctorIdRaw = req.query.doctorId ? String(req.query.doctorId).trim() : '';
    const doctorId =
      doctorIdRaw && mongoose.isValidObjectId(doctorIdRaw)
        ? new mongoose.Types.ObjectId(doctorIdRaw)
        : null;

    const baseFilter = {};
    mergeHospitalFilter(req, baseFilter);

    const appointmentBaseFilter = {};
    mergeHospitalFilter(req, appointmentBaseFilter);
    if (doctorId) {
      appointmentBaseFilter.doctor = doctorId;
    }

    const appointmentFilterToday = { ...appointmentBaseFilter, appointmentDateTime: istTodayRange() };
    const appointmentFilterTomorrow = { ...appointmentBaseFilter, appointmentDateTime: istTomorrowRange() };

    let rangeFilterForList = null;
    let patientIdsInRange = null;
    if (rangeParamsPresent) {
      rangeFilterForList = { ...appointmentBaseFilter, appointmentDateTime: {} };
      if (fromDate) {
        const g = parseCalendarDayStartUtc(fromDate);
        if (g) rangeFilterForList.appointmentDateTime.$gte = g;
      }
      if (toDate) {
        const lte = parseCalendarDayEndUtc(toDate);
        if (lte) rangeFilterForList.appointmentDateTime.$lte = lte;
      }
      if (
        rangeFilterForList.appointmentDateTime.$gte != null ||
        rangeFilterForList.appointmentDateTime.$lte != null
      ) {
        patientIdsInRange = await Appointment.find(rangeFilterForList).distinct('patient');
      } else {
        rangeFilterForList = null;
      }
    }

    const dateRangeActive = Array.isArray(patientIdsInRange) && !usePresetDayFilter;

    const appointmentCountFilter = dateRangeActive
      ? rangeFilterForList
      : usePresetDayFilter
        ? {
            ...appointmentBaseFilter,
            appointmentDateTime:
              filterChoice === 'today' ? istTodayRange() : istTomorrowRange(),
          }
        : appointmentBaseFilter;

    const [totalAppointments, patientIdsToday, patientIdsTomorrow] = await Promise.all([
      Appointment.countDocuments(appointmentCountFilter),
      Appointment.find(appointmentFilterToday).distinct('patient'),
      Appointment.find(appointmentFilterTomorrow).distinct('patient'),
    ]);

    let countAll;
    if (usePresetDayFilter) {
      countAll = filterChoice === 'today' ? patientIdsToday.length : patientIdsTomorrow.length;
    } else if (dateRangeActive) {
      countAll = patientIdsInRange.length;
    } else if (doctorId) {
      countAll = (await Appointment.distinct('patient', appointmentBaseFilter)).length;
    } else {
      countAll = await Patient.countDocuments(baseFilter);
    }

    const countToday = patientIdsToday.length;
    const countTomorrow = patientIdsTomorrow.length;

    const listFilter = { ...baseFilter };
    if (usePresetDayFilter) {
      listFilter._id = {
        $in: filterChoice === 'today' ? patientIdsToday : patientIdsTomorrow,
      };
    } else if (dateRangeActive) {
      listFilter._id = { $in: patientIdsInRange };
    } else if (doctorId && filterChoice === 'all') {
      const patientIdsForDoctor = await Appointment.find(appointmentBaseFilter).distinct('patient');
      listFilter._id = { $in: patientIdsForDoctor };
    }

    const [patients, total] = await Promise.all([
      Patient.find(listFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Patient.countDocuments(listFilter),
    ]);

    const patientIds = patients.map((p) => p._id);
    const appointmentFilter = patientIds.length ? { patient: { $in: patientIds } } : {};
    mergeHospitalFilter(req, appointmentFilter);
    if (doctorId) {
      appointmentFilter.doctor = doctorId;
    }
    if (dateRangeActive) {
      appointmentFilter.appointmentDateTime = {};
      if (fromDate) {
        const g = parseCalendarDayStartUtc(fromDate);
        if (g) appointmentFilter.appointmentDateTime.$gte = g;
      }
      if (toDate) {
        const lte = parseCalendarDayEndUtc(toDate);
        if (lte) appointmentFilter.appointmentDateTime.$lte = lte;
      }
    } else if (usePresetDayFilter) {
      appointmentFilter.appointmentDateTime =
        filterChoice === 'today' ? istTodayRange() : istTomorrowRange();
    }
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

    const counts = {
      all: countAll,
      today: countToday,
      tomorrow: countTomorrow,
    };
    if (dateRangeActive) {
      counts.inRange = patientIdsInRange.length;
    }

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        overall: {
          totalPatients: countAll,
          totalAppointments,
        },
        counts,
        ...(dateRangeActive
          ? {
              dateRange: {
                fromDate: fromDate || null,
                toDate: toDate || null,
              },
            }
          : {}),
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
