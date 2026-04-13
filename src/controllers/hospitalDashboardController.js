const mongoose = require('mongoose');
const Appointment = require('../models/appointment.model');
const Patient = require('../models/patient.model');
const Doctor = require('../models/doctor.model');
const { ROLES } = require('../constants/roles');
const { getHospitalFilter, getLinkedHospitalForResponse } = require('../utils/hospitalScope');
const { normalizeRole } = require('../middleware/hospitalSettingsAccess');
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  formatCalendarDateIST,
} = require('../utils/queryDateRange');

const APPOINTMENT_COLL = Appointment.collection.collectionName;

const DONUT_LABELS = {
  cancelled: 'Cancelled',
  first_time_visit: 'First time visit',
  follow_up_completed: 'Follow ups',
  scheduled_confirmed: 'Confirmed',
};

function firstTrimmed(q, keys) {
  for (const k of keys) {
    const v = q[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function istDaysBeforeCalendarKey(todayKey, daysBack) {
  const t0 = parseCalendarDayStartUtc(todayKey);
  if (!t0) return null;
  const t1 = new Date(t0.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return formatCalendarDateIST(t1);
}

/**
 * Resolve IST calendar [fromKey, toKey] as YYYY-MM-DD and UTC bounds for queries.
 */
function resolveDashboardRange(req) {
  const todayKey = formatCalendarDateIST(new Date());
  const rawPreset = String(req.query.preset || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  let fromKey;
  let toKey;
  let presetUsed = 'last_30_days';

  const fromCustom = firstTrimmed(req.query, ['from_date', 'fromDate', 'start_date', 'startDate']);
  const toCustom = firstTrimmed(req.query, ['to_date', 'toDate', 'end_date', 'endDate']);
  const dr = getDateRangeFromQuery(req.query);
  const fromAlt = fromCustom || dr.fromDate;
  const toAlt = toCustom || dr.toDate;

  if (rawPreset === 'last_7_days' || rawPreset === 'last7') {
    presetUsed = 'last_7_days';
    fromKey = istDaysBeforeCalendarKey(todayKey, 6);
    toKey = todayKey;
  } else if (rawPreset === 'this_month') {
    presetUsed = 'this_month';
    const [y, m] = todayKey.split('-');
    fromKey = `${y}-${m}-01`;
    toKey = todayKey;
  } else if (rawPreset === 'custom' || (fromAlt && toAlt)) {
    presetUsed = 'custom';
    fromKey = fromAlt;
    toKey = toAlt;
  } else if (fromAlt || toAlt) {
    presetUsed = 'custom';
    fromKey = fromAlt || toAlt;
    toKey = toAlt || fromAlt;
  } else {
    presetUsed = 'last_30_days';
    fromKey = istDaysBeforeCalendarKey(todayKey, 29);
    toKey = todayKey;
  }

  if (!fromKey || !toKey || !/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) {
    return { error: { status: 400, message: 'Invalid date range; use YYYY-MM-DD (IST day)' } };
  }

  let fromUtc = parseCalendarDayStartUtc(fromKey);
  let toUtc = parseCalendarDayEndUtc(toKey);
  if (!fromUtc || !toUtc) {
    return { error: { status: 400, message: 'Could not parse date range' } };
  }
  if (fromUtc > toUtc) {
    const swapK = fromKey;
    fromKey = toKey;
    toKey = swapK;
    fromUtc = parseCalendarDayStartUtc(fromKey);
    toUtc = parseCalendarDayEndUtc(toKey);
    if (!fromUtc || !toUtc) {
      return { error: { status: 400, message: 'Invalid date range' } };
    }
  }

  const rangeMs = toUtc.getTime() - fromUtc.getTime();
  const prevToUtc = new Date(fromUtc.getTime() - 1);
  const prevFromUtc = new Date(prevToUtc.getTime() - rangeMs);
  const prevFromKey = formatCalendarDateIST(prevFromUtc);
  const prevToKey = formatCalendarDateIST(prevToUtc);

  return {
    presetUsed,
    fromKey,
    toKey,
    fromUtc,
    toUtc,
    prevFromUtc,
    prevToUtc,
    prevFromKey,
    prevToKey,
  };
}

function growthPercent(current, previous) {
  if (previous == null || Number.isNaN(previous)) return 0;
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function aggregateDonut(hospitalId, fromUtc, toUtc) {
  const hid =
    hospitalId instanceof mongoose.Types.ObjectId ? hospitalId : new mongoose.Types.ObjectId(String(hospitalId));

  const pipeline = [
    {
      $match: {
        hospital: hid,
        appointmentDateTime: { $gte: fromUtc, $lte: toUtc },
      },
    },
    {
      $lookup: {
        from: APPOINTMENT_COLL,
        let: {
          pid: '$patient',
          hid: '$hospital',
          dt: '$appointmentDateTime',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$patient', '$$pid'] },
                  { $eq: ['$hospital', '$$hid'] },
                  { $lt: ['$appointmentDateTime', '$$dt'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'prior',
      },
    },
    {
      $addFields: {
        hasPrior: { $gt: [{ $size: '$prior' }, 0] },
        isCancelled: { $eq: ['$status', 'Cancelled'] },
      },
    },
    {
      $addFields: {
        donutSegment: {
          $cond: [
            '$isCancelled',
            'cancelled',
            {
              $cond: [
                { $not: '$hasPrior' },
                'first_time_visit',
                {
                  $cond: [
                    { $in: ['$status', ['Today', 'Upcoming']] },
                    'scheduled_confirmed',
                    'follow_up_completed',
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    { $group: { _id: '$donutSegment', count: { $sum: 1 } } },
  ];

  const rows = await Appointment.aggregate(pipeline);
  const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const total = rows.reduce((s, r) => s + r.count, 0);
  const segments = ['cancelled', 'first_time_visit', 'follow_up_completed', 'scheduled_confirmed'].map((id) => {
    const count = map[id] || 0;
    return {
      id,
      label: DONUT_LABELS[id],
      count,
      percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
  return { total, segments, rawCounts: map };
}

async function countByStatus(hospitalId, fromUtc, toUtc) {
  const hid =
    hospitalId instanceof mongoose.Types.ObjectId ? hospitalId : new mongoose.Types.ObjectId(String(hospitalId));
  const rows = await Appointment.aggregate([
    {
      $match: {
        hospital: hid,
        appointmentDateTime: { $gte: fromUtc, $lte: toUtc },
      },
    },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const out = { Today: 0, Upcoming: 0, Completed: 0, Cancelled: 0 };
  for (const r of rows) {
    if (r._id && Object.prototype.hasOwnProperty.call(out, r._id)) {
      out[r._id] = r.count;
    }
  }
  return out;
}

function enumerateIstDayKeys(fromKey, toKey) {
  const keys = [];
  let cur = fromKey;
  const guard = 400;
  let n = 0;
  while (cur <= toKey && n < guard) {
    keys.push(cur);
    const d = parseCalendarDayStartUtc(cur);
    if (!d) break;
    cur = formatCalendarDateIST(new Date(d.getTime() + 24 * 60 * 60 * 1000));
    n += 1;
  }
  return keys;
}

function istWeekdayShort(dayKey) {
  const d = parseCalendarDayStartUtc(dayKey);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' }).format(d);
}

/** One row per calendar day in range (IST keys), for bar chart. */
async function buildDailySeries(hospitalId, fromKey, toKey, fromUtc, toUtc) {
  const hid =
    hospitalId instanceof mongoose.Types.ObjectId ? hospitalId : new mongoose.Types.ObjectId(String(hospitalId));

  const apptRows = await Appointment.aggregate([
    {
      $match: {
        hospital: hid,
        appointmentDateTime: { $gte: fromUtc, $lte: toUtc },
      },
    },
    {
      $project: {
        dayKey: {
          $dateToString: { format: '%Y-%m-%d', date: '$appointmentDateTime', timezone: 'Asia/Kolkata' },
        },
        type: 1,
        patient: 1,
      },
    },
    {
      $group: {
        _id: '$dayKey',
        totalAppointments: { $sum: 1 },
        emergencyAppointments: {
          $sum: { $cond: [{ $eq: ['$type', 'emergency'] }, 1, 0] },
        },
        patientIds: { $addToSet: '$patient' },
      },
    },
  ]);

  const apptMap = Object.fromEntries(apptRows.map((r) => [r._id, r]));

  const patientNewRows = await Patient.aggregate([
    {
      $match: {
        hospital: hid,
        createdAt: { $gte: fromUtc, $lte: toUtc },
      },
    },
    {
      $project: {
        dayKey: {
          $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' },
        },
      },
    },
    { $group: { _id: '$dayKey', newPatientRegistrations: { $sum: 1 } } },
  ]);
  const newMap = Object.fromEntries(patientNewRows.map((r) => [r._id, r.newPatientRegistrations]));

  const series = [];
  for (const key of enumerateIstDayKeys(fromKey, toKey)) {
    const bucket = apptMap[key] || {
      totalAppointments: 0,
      emergencyAppointments: 0,
      patientIds: [],
    };
    series.push({
      date: key,
      dayOfWeek: istWeekdayShort(key),
      totalAppointments: bucket.totalAppointments || 0,
      uniquePatientsWithAppointments: (bucket.patientIds || []).length,
      emergencyAppointments: bucket.emergencyAppointments || 0,
      newPatientRegistrations: newMap[key] || 0,
    });
  }

  return series;
}

/**
 * GET /api/dashboard/hospital-admin
 */
const getHospitalAdminDashboard = async (req, res, next) => {
  try {
    if (normalizeRole(req.user.role) !== ROLES.HOSPITAL_ADMIN) {
      return res.status(403).json({ success: false, message: 'Only hospital_admin can access this dashboard' });
    }

    const scope = getHospitalFilter(req);
    if (!scope.hospital) {
      return res.status(403).json({
        success: false,
        message: 'You must be linked to a hospital to view the dashboard.',
      });
    }

    const hospitalId = scope.hospital;
    const range = resolveDashboardRange(req);
    if (range.error) {
      return res.status(range.error.status).json({ success: false, message: range.error.message });
    }

    const {
      presetUsed,
      fromKey,
      toKey,
      fromUtc,
      toUtc,
      prevFromUtc,
      prevToUtc,
      prevFromKey,
      prevToKey,
    } = range;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const hid = hospitalId;

    const [
      totalPatientsAtHospital,
      newPatientsCurrent,
      newPatientsPrevious,
      appointmentsCurrent,
      appointmentsPrevious,
      distinctPatientsCurrent,
      distinctPatientsPrevious,
      donut,
      byStatus,
      doctorsSchedule,
      upcomingList,
      tableTotal,
      tableItems,
    ] = await Promise.all([
      Patient.countDocuments({ hospital: hid }),
      Patient.countDocuments({ hospital: hid, createdAt: { $gte: fromUtc, $lte: toUtc } }),
      Patient.countDocuments({ hospital: hid, createdAt: { $gte: prevFromUtc, $lte: prevToUtc } }),
      Appointment.countDocuments({ hospital: hid, appointmentDateTime: { $gte: fromUtc, $lte: toUtc } }),
      Appointment.countDocuments({ hospital: hid, appointmentDateTime: { $gte: prevFromUtc, $lte: prevToUtc } }),
      Appointment.distinct('patient', {
        hospital: hid,
        appointmentDateTime: { $gte: fromUtc, $lte: toUtc },
      }).then((a) => a.length),
      Appointment.distinct('patient', {
        hospital: hid,
        appointmentDateTime: { $gte: prevFromUtc, $lte: prevToUtc },
      }).then((a) => a.length),
      aggregateDonut(hid, fromUtc, toUtc),
      countByStatus(hid, fromUtc, toUtc),
      Doctor.find({ hospital: hid }).select('fullName designation status').sort({ fullName: 1 }).lean(),
      Appointment.find({
        hospital: hid,
        appointmentDateTime: { $gte: fromUtc, $lte: toUtc },
        status: { $ne: 'Cancelled' },
      })
        .sort({ appointmentDateTime: 1 })
        .limit(30)
        .populate('patient', 'fullName age phoneNumber gender')
        .populate('doctor', 'fullName designation')
        .lean(),
      Appointment.countDocuments({ hospital: hid, appointmentDateTime: { $gte: fromUtc, $lte: toUtc } }),
      Appointment.find({ hospital: hid, appointmentDateTime: { $gte: fromUtc, $lte: toUtc } })
        .sort({ appointmentDateTime: -1 })
        .skip(skip)
        .limit(limit)
        .populate('patient', 'fullName age phoneNumber gender')
        .populate('doctor', 'fullName designation')
        .lean(),
    ]);

    const dailyPatientVolume = await buildDailySeries(hid, fromKey, toKey, fromUtc, toUtc);

    const patientOverviewRows = tableItems.map((a) => ({
      appointmentId: a._id,
      appointmentRef: a.appointmentId || null,
      patient: a.patient
        ? {
            id: a.patient._id,
            fullName: a.patient.fullName,
            age: a.patient.age,
            phoneNumber: a.patient.phoneNumber,
            gender: a.patient.gender,
          }
        : null,
      reason: a.reason,
      type: a.type,
      status: a.status,
      appointmentDateTime: a.appointmentDateTime,
      doctor: a.doctor
        ? {
            id: a.doctor._id,
            fullName: a.doctor.fullName,
            designation: a.doctor.designation,
          }
        : null,
    }));

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        filters: {
          preset: presetUsed,
          startDate: fromKey,
          endDate: toKey,
          timezone: 'Asia/Kolkata',
        },
        comparisonPeriod: {
          startDate: prevFromKey,
          endDate: prevToKey,
        },
        summary: {
          patients: {
            totalRegisteredAtHospital: totalPatientsAtHospital,
            newRegistrationsInRange: newPatientsCurrent,
            growthPercentVsPreviousRange: growthPercent(newPatientsCurrent, newPatientsPrevious),
          },
          appointments: {
            countInRange: appointmentsCurrent,
            growthPercentVsPreviousRange: growthPercent(appointmentsCurrent, appointmentsPrevious),
          },
          visitors: {
            uniquePatientsWithAppointmentInRange: distinctPatientsCurrent,
            growthPercentVsPreviousRange: growthPercent(distinctPatientsCurrent, distinctPatientsPrevious),
          },
        },
        appointmentsBreakdown: {
          totalInRange: donut.total,
          donutSegments: donut.segments,
          byStatus,
        },
        doctorsSchedule: doctorsSchedule.map((d) => ({
          id: d._id,
          fullName: d.fullName,
          designation: d.designation,
          status: d.status,
        })),
        upcomingAppointmentsTimeline: upcomingList.map((a) => ({
          id: a._id,
          appointmentRef: a.appointmentId || null,
          appointmentDateTime: a.appointmentDateTime,
          type: a.type,
          status: a.status,
          patient: a.patient
            ? { fullName: a.patient.fullName, age: a.patient.age }
            : null,
          doctor: a.doctor ? { fullName: a.doctor.fullName, designation: a.doctor.designation } : null,
        })),
        charts: {
          patientVolumeByDay: dailyPatientVolume,
        },
        patientOverview: {
          items: patientOverviewRows,
          pagination: {
            page,
            limit,
            total: tableTotal,
            totalPages: Math.ceil(tableTotal / limit),
          },
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getHospitalAdminDashboard,
};
