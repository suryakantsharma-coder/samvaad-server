const mongoose = require("mongoose");
const PaymentHistory = require("../models/paymentHistory.model");
const Patient = require("../models/patient.model");
const Doctor = require("../models/doctor.model");
const { getLinkedHospitalForResponse } = require("../utils/hospitalScope");
const { ROLES, isHospitalRole } = require("../constants/roles");
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  firstTrimmedQueryValue,
  istTodayRange,
  istTomorrowRange,
} = require("../utils/queryDateRange");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function assertPaymentHospitalAccess(req, requested) {
  if (!mongoose.isValidObjectId(requested)) {
    return { error: { status: 400, json: { success: false, message: "Invalid hospitalId" } } };
  }
  const role = req.user.role;
  const isPlatformAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;

  if (isHospitalRole(role)) {
    if (!req.user.hospital) {
      return {
        error: {
          status: 403,
          json: {
            success: false,
            message: "You must be linked to a hospital to view payments",
          },
        },
      };
    }
    if (String(req.user.hospital) !== requested) {
      return {
        error: {
          status: 403,
          json: {
            success: false,
            message: "You can only view payments for your linked hospital",
          },
        },
      };
    }
  } else if (!isPlatformAdmin) {
    return { error: { status: 403, json: { success: false, message: "Insufficient permissions" } } };
  }

  return { hospitalId: requested };
}

/** @returns {'captured'|'failed'|'pending'|null} null = all statuses */
function parsePaymentStatusQuery(query) {
  const raw = firstTrimmedQueryValue(query, ["paymentStatus", "payment_status"]);
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "all") return null;
  if (s === "captured" || s === "failed" || s === "pending") return s;
  return null;
}

function buildDateRangeClause(query) {
  const { fromDate, toDate, hasDateRange: rangeParamsPresent } = getDateRangeFromQuery(query);
  if (!rangeParamsPresent) {
    return { rangeClause: null, fromDate: fromDate || null, toDate: toDate || null };
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
  if (!rangeClause.$gte && !rangeClause.$lte) {
    return { rangeClause: null, fromDate: fromDate || null, toDate: toDate || null };
  }
  return { rangeClause, fromDate: fromDate || null, toDate: toDate || null };
}

function applyStatusToFilter(filter, statusOutcome) {
  if (statusOutcome) filter.status = statusOutcome;
}

/**
 * GET /api/payments?hospitalId=&filter=all|today|tomorrow&paymentStatus=captured|failed|pending|all
 * Optional fromDate/toDate (IST calendar day on createdAt) overrides filter for the listed rows.
 */
const listByHospital = async (req, res, next) => {
  try {
    const requested = String(req.query.hospitalId || "").trim();
    const access = assertPaymentHospitalAccess(req, requested);
    if (access.error) {
      return res.status(access.error.status).json(access.error.json);
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const filterChoice = (req.query.filter || "all").toLowerCase();

    const hospitalOid = new mongoose.Types.ObjectId(requested);
    const baseFilter = { hospital: hospitalOid };
    const statusOutcome = parsePaymentStatusQuery(req.query);
    applyStatusToFilter(baseFilter, statusOutcome);

    const { rangeClause, fromDate: rangeFrom, toDate: rangeTo } = buildDateRangeClause(req.query);
    const dateRangeActive = Boolean(rangeClause);

    const filterToday = { ...baseFilter, createdAt: istTodayRange() };
    const filterTomorrow = { ...baseFilter, createdAt: istTomorrowRange() };

    const [countAllUnscoped, countToday, countTomorrow] = await Promise.all([
      PaymentHistory.countDocuments(baseFilter),
      PaymentHistory.countDocuments(filterToday),
      PaymentHistory.countDocuments(filterTomorrow),
    ]);

    const countAll = dateRangeActive
      ? await PaymentHistory.countDocuments({ ...baseFilter, createdAt: rangeClause })
      : countAllUnscoped;

    const listFilter = { ...baseFilter };
    if (dateRangeActive) {
      listFilter.createdAt = rangeClause;
    } else if (filterChoice === "today") {
      listFilter.createdAt = istTodayRange();
    } else if (filterChoice === "tomorrow") {
      listFilter.createdAt = istTomorrowRange();
    }

    const [payments, total, amountAgg] = await Promise.all([
      PaymentHistory.find(listFilter)
        .populate("hospital", "name registrationNumber city")
        .populate("patient", "fullName patientId phoneNumber")
        .populate("doctor", "fullName doctorId designation email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentHistory.countDocuments(listFilter),
      PaymentHistory.aggregate([
        { $match: { ...listFilter, status: "captured" } },
        { $group: { _id: null, totalAmountPaise: { $sum: "$amount" } } },
      ]),
    ]);

    const totalAmountPaise = amountAgg[0]?.totalAmountPaise ?? 0;

    const counts = {
      all: countAll,
      today: countToday,
      tomorrow: countTomorrow,
    };
    if (dateRangeActive) {
      counts.inRange = countAll;
    }

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        hospitalId: requested,
        overall: {
          totalPayments: countAll,
          totalAmountPaise,
        },
        counts,
        ...(dateRangeActive
          ? {
              dateRange: {
                fromDate: rangeFrom,
                toDate: rangeTo,
              },
            }
          : {}),
        payments,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/payments/search?q=&hospitalId=&paymentStatus=&fromDate=&toDate=
 * Search payment_id, order_id, and patient/doctor name or id (hospital-scoped).
 */
const search = async (req, res, next) => {
  try {
    const requested = String(req.query.hospitalId || "").trim();
    const access = assertPaymentHospitalAccess(req, requested);
    if (access.error) {
      return res.status(access.error.status).json(access.error.json);
    }

    const q = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const hospitalOid = new mongoose.Types.ObjectId(requested);
    const filter = { hospital: hospitalOid };
    const statusOutcome = parsePaymentStatusQuery(req.query);
    applyStatusToFilter(filter, statusOutcome);

    const { rangeClause, fromDate: rangeFrom, toDate: rangeTo } = buildDateRangeClause(req.query);
    const dateRangeActive = Boolean(rangeClause);
    if (rangeClause) {
      filter.createdAt = rangeClause;
    }

    if (q) {
      const regex = { $regex: q, $options: "i" };
      const orClause = [{ payment_id: regex }, { order_id: regex }];
      const [patientIds, doctorIds] = await Promise.all([
        Patient.find({
          hospital: hospitalOid,
          $or: [{ fullName: regex }, { patientId: regex }],
        }).distinct("_id"),
        Doctor.find({
          hospital: hospitalOid,
          $or: [{ fullName: regex }, { doctorId: regex }],
        }).distinct("_id"),
      ]);
      if (patientIds.length) orClause.push({ patient: { $in: patientIds } });
      if (doctorIds.length) orClause.push({ doctor: { $in: doctorIds } });
      filter.$or = orClause;
    }

    const [payments, total, amountAgg] = await Promise.all([
      PaymentHistory.find(filter)
        .populate("hospital", "name registrationNumber city")
        .populate("patient", "fullName patientId phoneNumber")
        .populate("doctor", "fullName doctorId designation email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentHistory.countDocuments(filter),
      PaymentHistory.aggregate([
        { $match: { ...filter, status: "captured" } },
        { $group: { _id: null, totalAmountPaise: { $sum: "$amount" } } },
      ]),
    ]);

    const totalAmountPaise = amountAgg[0]?.totalAmountPaise ?? 0;

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        hospitalId: requested,
        overall: {
          totalPayments: total,
          totalAmountPaise,
        },
        ...(dateRangeActive
          ? {
              dateRange: {
                fromDate: rangeFrom,
                toDate: rangeTo,
              },
            }
          : {}),
        payments,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listByHospital,
  search,
};
