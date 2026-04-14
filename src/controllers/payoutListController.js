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

function parsePayoutStatusQuery(query) {
  const raw = firstTrimmedQueryValue(query, ["status", "payoutStatus"]);
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

    const [items, total] = await Promise.all([
      PayoutList.find(filter)
        .sort({ startDate: -1, hospitalName: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
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

module.exports = {
  list,
};
