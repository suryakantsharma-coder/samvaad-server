const Prescription = require('../models/prescription.model');
const Patient = require('../models/patient.model');
const Appointment = require('../models/appointment.model');
const mongoose = require('mongoose');
const { mergeHospitalFilter, getLinkedHospitalForResponse, getHospitalFilter } = require('../utils/hospitalScope');
const { notifyPrescriptionCreated } = require('../services/prescriptionWhatsAppNotify');
const { schedulePrescriptionReminders } = require('../services/reminder.service');
const {
  applyPrescriptionPopulate,
  enrichMedicinesWithDoctorHospital,
} = require('../utils/prescriptionPopulate');
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  firstTrimmedQueryValue,
} = require('../utils/queryDateRange');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Build frequency string from intake + time for display/search */
function buildFrequency(intake, time) {
  const parts = [];
  if (intake && typeof intake === 'string' && intake.trim()) parts.push(intake.trim() + ' food');
  if (time && typeof time === 'object') {
    if (time.breakfast) parts.push('Breakfast');
    if (time.lunch) parts.push('Lunch');
    if (time.dinner) parts.push('Dinner');
  }
  return parts.length ? parts.join(', ') : '';
}

/** Store medicine with all sent details: dosage/duration as-is (object or string), plus intake, time, notes, frequency. */
function normalizeMedicine(m) {
  const frequency =
    (typeof m.frequency === 'string' && m.frequency.trim()) ||
    buildFrequency(m.intake, m.time) ||
    'As directed';
  return {
    name: typeof m.name === 'string' ? m.name.trim() : '',
    dosage: m.dosage !== undefined && m.dosage !== null ? m.dosage : undefined,
    frequency: frequency || 'As directed',
    duration: m.duration !== undefined && m.duration !== null ? m.duration : undefined,
    intake: typeof m.intake === 'string' ? m.intake.trim() : '',
    time: m.time && typeof m.time === 'object' ? m.time : undefined,
    notes: typeof m.notes === 'string' ? m.notes.trim() : '',
  };
}

/** Normalize followUp: ensure { value, unit } shape. */
function normalizeFollowUp(followUp) {
  if (followUp == null) return undefined;
  if (typeof followUp === 'object' && ('value' in followUp || 'unit' in followUp)) {
    return { value: followUp.value, unit: followUp.unit ? String(followUp.unit).trim() : '' };
  }
  return undefined;
}

/**
 * Apply IST calendar-day range to a prescription query filter (same semantics as payments).
 * When `dateBy=appointment`, combines with an existing text-search `$or` via `$and` so both match.
 *
 * If `dateBy` is omitted, defaults to **appointment** — only `prescription.appointmentDate`
 * (IST calendar-day bounds). Pass `dateBy=created` for `createdAt`.
 *
 * @returns {Promise<{ dateRangeApplied: boolean, fromDate: string|null, toDate: string|null, filterByAppointmentDate: boolean }>}
 */
async function mergePrescriptionDateRange(req, filter, query) {
  const { fromDate, toDate, hasDateRange: hasRangeParams } = getDateRangeFromQuery(query);
  const dateByParam = firstTrimmedQueryValue(query, ['dateBy', 'date_by']);
  const dateBy = dateByParam ? String(dateByParam).toLowerCase() : 'appointment';
  const filterByAppointmentDate = dateBy === 'appointment';

  if (!hasRangeParams) {
    return {
      dateRangeApplied: false,
      fromDate: fromDate || null,
      toDate: toDate || null,
      filterByAppointmentDate,
    };
  }

  const rangeClause = {};
  if (fromDate) {
    const g = parseCalendarDayStartUtc(fromDate);
    if (g) rangeClause.$gte = g;
  }
  if (toDate) {
    const lte = parseCalendarDayEndUtc(toDate);
    if (lte) rangeClause.$lte = lte;
  }
  if (!(rangeClause.$gte || rangeClause.$lte)) {
    return {
      dateRangeApplied: false,
      fromDate: fromDate || null,
      toDate: toDate || null,
      filterByAppointmentDate,
    };
  }

  if (filterByAppointmentDate) {
    const appointmentDateClause = { appointmentDate: rangeClause };
    if (filter.$or && Array.isArray(filter.$or)) {
      const searchOr = filter.$or;
      delete filter.$or;
      filter.$and = [{ $or: searchOr }, appointmentDateClause];
    } else {
      Object.assign(filter, appointmentDateClause);
    }
    return {
      dateRangeApplied: true,
      fromDate: fromDate || null,
      toDate: toDate || null,
      filterByAppointmentDate: true,
    };
  }

  filter.createdAt = rangeClause;
  return {
    dateRangeApplied: true,
    fromDate: fromDate || null,
    toDate: toDate || null,
    filterByAppointmentDate: false,
  };
}

/**
 * @route GET /api/prescriptions
 * Query: page, limit, status; date range fromDate/toDate, startDate/endDate, or snake_case (YYYY-MM-DD = IST day).
 * `dateBy` (or `date_by`): omitted → **appointment** (`prescription.appointmentDate` only, IST days);
 * `created` → createdAt.
 */
const getAll = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    mergeHospitalFilter(req, filter);
    const baseFilter = { ...filter };

    const { dateRangeApplied, fromDate, toDate, filterByAppointmentDate } = await mergePrescriptionDateRange(
      req,
      filter,
      req.query,
    );

    const [listRows, total, countAllUnscoped] = await Promise.all([
      applyPrescriptionPopulate(Prescription.find(filter))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Prescription.countDocuments(filter),
      Prescription.countDocuments(baseFilter),
    ]);

    const countAll = dateRangeApplied ? total : countAllUnscoped;
    const counts = {
      all: countAll,
      ...(dateRangeApplied ? { inRange: total } : {}),
    };

    const prescriptions = listRows.map((p) => enrichMedicinesWithDoctorHospital(p));

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        overall: {
          totalPrescriptions: countAll,
        },
        counts,
        ...(dateRangeApplied
          ? {
              dateRange: {
                fromDate: fromDate || null,
                toDate: toDate || null,
                dateBy: filterByAppointmentDate ? 'appointment' : 'created',
              },
            }
          : {}),
        prescriptions,
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
 * @route GET /api/prescriptions/search?q=...
 * Search notes, snapshot patientName, medicine fields, and patients (fullName / patientId) hospital-scoped.
 * Optional status, fromDate/toDate (IST), dateBy (omit → appointment on prescription.appointmentDate).
 */
const search = async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    mergeHospitalFilter(req, filter);

    if (q) {
      const regex = { $regex: q, $options: 'i' };
      const orClause = [
        { notes: regex },
        { patientName: regex },
        { 'medicines.name': regex },
        { 'medicines.dosage': regex },
        { 'medicines.frequency': regex },
      ];
      const patientFilter = {};
      mergeHospitalFilter(req, patientFilter);
      const patientIds = await Patient.find({
        ...patientFilter,
        $or: [{ fullName: regex }, { patientId: regex }],
      }).distinct('_id');
      if (patientIds.length) orClause.push({ patient: { $in: patientIds } });
      filter.$or = orClause;
    }

    const baseFilter = { ...filter };

    const { dateRangeApplied, fromDate, toDate, filterByAppointmentDate } = await mergePrescriptionDateRange(
      req,
      filter,
      req.query,
    );

    const [searchRows, total, countAllUnscoped] = await Promise.all([
      applyPrescriptionPopulate(Prescription.find(filter))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Prescription.countDocuments(filter),
      Prescription.countDocuments(baseFilter),
    ]);

    const countAll = dateRangeApplied ? total : countAllUnscoped;
    const counts = {
      all: countAll,
      ...(dateRangeApplied ? { inRange: total } : {}),
    };

    const prescriptions = searchRows.map((p) => enrichMedicinesWithDoctorHospital(p));

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        overall: {
          totalPrescriptions: countAll,
        },
        counts,
        ...(dateRangeApplied
          ? {
              dateRange: {
                fromDate: fromDate || null,
                toDate: toDate || null,
                dateBy: filterByAppointmentDate ? 'appointment' : 'created',
              },
            }
          : {}),
        prescriptions,
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
 * @route GET /api/prescriptions/:id
 */
const getById = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    mergeHospitalFilter(req, query);

    const raw = await applyPrescriptionPopulate(
      Prescription.findOne(query),
      'fullName patientId phoneNumber age gender'
    ).lean();

    if (!raw) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    const prescription = enrichMedicinesWithDoctorHospital(raw);

    res.json({ success: true, ...getLinkedHospitalForResponse(req), data: { prescription } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route POST /api/prescriptions
 * Body: patient or patientId, appointmentId (optional), medicines[], notes, status.
 * Medicines: name required; dosage/duration can be string or { value, unit }; frequency optional (or use intake + time).
 */
const create = async (req, res, next) => {
  try {
    const patientId = req.body.patientId || req.body.patient;
    const appointmentId = req.body.appointmentId || req.body.appointment || null;
    const rawMedicines = Array.isArray(req.body.medicines) ? req.body.medicines : [];
    const medicines = rawMedicines.map(normalizeMedicine);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    let hospitalId = patient.hospital || null;
    let linkedAppointment = null;
    if (appointmentId && mongoose.isValidObjectId(appointmentId)) {
      linkedAppointment = await Appointment.findById(appointmentId).lean();
      if (linkedAppointment) {
        hospitalId = linkedAppointment.hospital || hospitalId;
        if (patient.hospital && linkedAppointment.hospital && !patient.hospital.equals(linkedAppointment.hospital)) {
          return res.status(400).json({
            success: false,
            message: 'Appointment and patient must belong to the same hospital',
          });
        }
      }
    }

    const scope = getHospitalFilter(req);
    if (scope.hospital) {
      const linked = String(scope.hospital);
      const patHospital = patient.hospital ? String(patient.hospital) : null;
      if (patHospital && patHospital !== linked) {
        return res.status(403).json({
          success: false,
          message: 'You can only create prescriptions for patients in your linked hospital',
        });
      }
    }

    let appointmentDate = req.body.appointmentDate
      ? new Date(req.body.appointmentDate)
      : undefined;
    if (
      (!appointmentDate || isNaN(appointmentDate.getTime())) &&
      linkedAppointment &&
      linkedAppointment.appointmentDateTime
    ) {
      appointmentDate = new Date(linkedAppointment.appointmentDateTime);
    }
    const followUp = normalizeFollowUp(req.body.followUp);
    const patientName = typeof req.body.patientName === 'string' ? req.body.patientName.trim() : '';

    const payload = {
      patient: patientId,
      patientName: patientName || undefined,
      appointment: appointmentId || undefined,
      appointmentDate: appointmentDate && !isNaN(appointmentDate.getTime()) ? appointmentDate : undefined,
      followUp,
      hospital: hospitalId || undefined,
      medicines,
      notes: (req.body.notes || '').trim(),
      status: req.body.status || 'Draft',
    };

    const prescription = await Prescription.create(payload);

    const scheduleLean = prescription.toObject();
    schedulePrescriptionReminders(scheduleLean).catch((err) =>
      console.error('[Reminder] schedulePrescriptionReminders:', err.message),
    );

    const populatedRaw = await applyPrescriptionPopulate(Prescription.findById(prescription._id)).lean();
    const populated = enrichMedicinesWithDoctorHospital(populatedRaw);

    res.status(201).json({ success: true, data: { prescription: populated } });

    if (populated.appointment) {
      notifyPrescriptionCreated(populated).catch((err) =>
        console.error('[WhatsApp] prescription created notify:', err.message, err.details || '')
      );
    }
  } catch (err) {
    next(err);
  }
};

/**
 * @route PATCH /api/prescriptions/:id
 */
const update = async (req, res, next) => {
  try {
    const updateData = {};
    if (req.body.status !== undefined) updateData.status = req.body.status;
    if (req.body.notes !== undefined) updateData.notes = req.body.notes;
    if (req.body.patientName !== undefined) updateData.patientName = typeof req.body.patientName === 'string' ? req.body.patientName.trim() : '';
    if (req.body.appointmentDate !== undefined) {
      const d = new Date(req.body.appointmentDate);
      updateData.appointmentDate = !isNaN(d.getTime()) ? d : undefined;
    }
    if (req.body.followUp !== undefined) updateData.followUp = normalizeFollowUp(req.body.followUp);
    if (req.body.medicines !== undefined) {
      const raw = Array.isArray(req.body.medicines) ? req.body.medicines : [];
      updateData.medicines = raw.map(normalizeMedicine);
    }
    const patientId = req.body.patientId ?? req.body.patient;
    if (patientId !== undefined) updateData.patient = patientId;
    const appointmentId = req.body.appointmentId ?? req.body.appointment;
    if (appointmentId !== undefined) updateData.appointment = appointmentId || undefined;

    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const updatedRaw = await applyPrescriptionPopulate(
      Prescription.findOneAndUpdate(filter, { $set: updateData }, { new: true, runValidators: true })
    ).lean();

    if (!updatedRaw) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    const prescription = enrichMedicinesWithDoctorHospital(updatedRaw);

    res.json({ success: true, data: { prescription } });
  } catch (err) {
    next(err);
  }
};

/**
 * @route DELETE /api/prescriptions/:id
 */
const remove = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);
    const prescription = await Prescription.findOneAndDelete(filter);
    if (!prescription) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }
    res.json({ success: true, message: 'Prescription deleted successfully' });
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
