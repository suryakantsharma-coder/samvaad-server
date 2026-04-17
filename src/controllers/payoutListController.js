const mongoose = require("mongoose");
const PayoutList = require("../models/payoutList.model");
const { ROLES, isHospitalRole } = require("../constants/roles");
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  firstTrimmedQueryValue,
} = require("../utils/queryDateRange");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @returns {Record<string, 1|-1>} Sort by billing period startDate (newest = descending), then hospital name */
function getPayoutListSort(query) {
  const raw = firstTrimmedQueryValue(query, ["sort"]);
  const startDir = String(raw).toLowerCase() === "oldest" ? 1 : -1;
  return { startDate: startDir, hospitalName: 1 };
}

function parsePayoutStatusQuery(query) {
  const raw = firstTrimmedQueryValue(query, ["status", "payoutStatus", "filter"]);
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "all") return null;
  if (s === "draft" || s === "paid") return s;
  return null;
}

/**
 * GET /api/payouts
 * Platform admins: optional hospitalId (omit = all hospitals).
 * Hospital-linked roles: scoped to their hospital; hospitalId if present must match.
 * Date range (IST calendar): includes payouts whose billing period [startDate, endDate] **overlaps**
 * the query window [fromDate…toDate]. Mid-month fromDate still matches month-level payout rows (period starts on the 1st).
 * Optional sort=newest|oldest (default newest): order by startDate then hospitalName.
 * Payout row status: use status, payoutStatus, or filter — each draft|paid|all (first non-empty wins in that order).
 */
const list = async (req, res, next) => {
  try {
    const role = req.user.role;
    const isPlatformAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
    const requestedHospital = String(req.query.hospitalId || "").trim();

    const filter = {};

    if (isHospitalRole(role)) {
      if (!req.user.hospital) {
        return res.status(403).json({
          success: false,
          message: "You must be linked to a hospital to view payouts",
        });
      }
      if (requestedHospital && String(requestedHospital) !== String(req.user.hospital)) {
        return res.status(403).json({
          success: false,
          message: "You can only view payouts for your linked hospital",
        });
      }
      filter.hospitalId = req.user.hospital;
    } else if (!isPlatformAdmin) {
      return res.status(403).json({ success: false, message: "Insufficient permissions" });
    } else if (requestedHospital) {
      if (!mongoose.isValidObjectId(requestedHospital)) {
        return res.status(400).json({ success: false, message: "Invalid hospitalId" });
      }
      filter.hospitalId = new mongoose.Types.ObjectId(requestedHospital);
    }

    const statusFilter = parsePayoutStatusQuery(req.query);
    if (statusFilter) {
      filter.status = statusFilter;
    }

    const { fromDate, toDate, hasDateRange } = getDateRangeFromQuery(req.query);
    if (hasDateRange) {
      const queryFrom = fromDate ? parseCalendarDayStartUtc(fromDate) : null;
      const queryTo = toDate ? parseCalendarDayEndUtc(toDate) : null;
      const overlap = [];
      if (queryTo) overlap.push({ startDate: { $lte: queryTo } });
      if (queryFrom) overlap.push({ endDate: { $gte: queryFrom } });
      if (overlap.length) {
        filter.$and = [...(filter.$and || []), ...overlap];
      }
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const sortSpec = getPayoutListSort(req.query);

    const [items, total] = await Promise.all([
      PayoutList.find(filter).sort(sortSpec).skip(skip).limit(limit).lean(),
      PayoutList.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (err) {
    return next(err);
  }
};

function buildPayoutSearchOrClause(q) {
  const trimmed = String(q).trim();
  if (!trimmed) return null;
  const regex = new RegExp(escapeRegex(trimmed), "i");
  const orClause = [{ hospitalName: regex }, { status: regex }];
  if (mongoose.isValidObjectId(trimmed)) {
    const oid = new mongoose.Types.ObjectId(trimmed);
    orClause.push({ _id: oid });
    orClause.push({ hospitalId: oid });
  }
  const asNum = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(asNum) && String(asNum) === trimmed) {
    orClause.push({ totalPrice: asNum });
  }
  return orClause;
}

/**
 * GET /api/payouts/search
 * Same hospital / role rules as GET /api/payouts. Optional q filters list rows; status and date range match list semantics.
 */
const search = async (req, res, next) => {
  try {
    const role = req.user.role;
    const isPlatformAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
    const requestedHospital = String(req.query.hospitalId || "").trim();
    const q = String(req.query.q || "").trim();

    const filter = {};

    if (isHospitalRole(role)) {
      if (!req.user.hospital) {
        return res.status(403).json({
          success: false,
          message: "You must be linked to a hospital to view payouts",
        });
      }
      if (requestedHospital && String(requestedHospital) !== String(req.user.hospital)) {
        return res.status(403).json({
          success: false,
          message: "You can only view payouts for your linked hospital",
        });
      }
      filter.hospitalId = req.user.hospital;
    } else if (!isPlatformAdmin) {
      return res.status(403).json({ success: false, message: "Insufficient permissions" });
    } else if (requestedHospital) {
      if (!mongoose.isValidObjectId(requestedHospital)) {
        return res.status(400).json({ success: false, message: "Invalid hospitalId" });
      }
      filter.hospitalId = new mongoose.Types.ObjectId(requestedHospital);
    }

    const statusFilter = parsePayoutStatusQuery(req.query);
    if (statusFilter) {
      filter.status = statusFilter;
    }

    const { fromDate, toDate, hasDateRange } = getDateRangeFromQuery(req.query);
    if (hasDateRange) {
      const queryFrom = fromDate ? parseCalendarDayStartUtc(fromDate) : null;
      const queryTo = toDate ? parseCalendarDayEndUtc(toDate) : null;
      const overlap = [];
      if (queryTo) overlap.push({ startDate: { $lte: queryTo } });
      if (queryFrom) overlap.push({ endDate: { $gte: queryFrom } });
      if (overlap.length) {
        filter.$and = [...(filter.$and || []), ...overlap];
      }
    }

    if (q) {
      const orClause = buildPayoutSearchOrClause(q);
      if (orClause && orClause.length) {
        filter.$or = orClause;
      }
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const sortSpec = getPayoutListSort(req.query);

    const [items, total] = await Promise.all([
      PayoutList.find(filter).sort(sortSpec).skip(skip).limit(limit).lean(),
      PayoutList.countDocuments(filter),
    ]);

    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  list,
  search,
};
