const mongoose = require("mongoose");
const PaymentTransaction = require("../models/paymentTransaction.model");
const PayoutList = require("../models/payoutList.model");
const {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  firstTrimmedQueryValue,
} = require("../utils/queryDateRange");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Razorpay-style statuses we allow super_admin to set manually (audit-sensitive). */
const ALLOWED_RAZORPAY_STATUS = new Set([
  "captured",
  "failed",
  "authorized",
  "refunded",
  "pending",
]);

/** PayoutList.status enum — super_admin manual override. */
const ALLOWED_PAYOUT_LIST_STATUS = new Set(["draft", "paid"]);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTransactionStatus(body) {
  const raw = body.razorpayStatus ?? body.status;
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim().toLowerCase();
}

function normalizePayoutListStatus(body) {
  const raw = body.status ?? body.payoutStatus;
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim().toLowerCase();
}

/**
 * PATCH /api/payouts/transactions/:id/status
 * Super admin only. Updates PaymentTransaction.razorpayStatus.
 */
const patchTransactionStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const nextStatus = normalizeTransactionStatus(req.body);
    if (!nextStatus || !ALLOWED_RAZORPAY_STATUS.has(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: `razorpayStatus must be one of: ${[...ALLOWED_RAZORPAY_STATUS].join(", ")}`,
      });
    }

    const doc = await PaymentTransaction.findByIdAndUpdate(
      id,
      { $set: { razorpayStatus: nextStatus } },
      { new: true, runValidators: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ success: false, message: "Payment transaction not found" });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    return next(err);
  }
};

/**
 * PATCH /api/payouts/list/:id/status
 * Super admin only. Updates PayoutList.status (draft | paid).
 */
const patchPayoutListRecordStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const nextStatus = normalizePayoutListStatus(req.body);
    if (!nextStatus || !ALLOWED_PAYOUT_LIST_STATUS.has(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${[...ALLOWED_PAYOUT_LIST_STATUS].join(", ")}`,
      });
    }

    const doc = await PayoutList.findByIdAndUpdate(
      id,
      { $set: { status: nextStatus } },
      { new: true, runValidators: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ success: false, message: "Payout list not found" });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    return next(err);
  }
};

function parseTxStatusFilter(query) {
  const raw = firstTrimmedQueryValue(query, [
    "razorpayStatus",
    "transactionStatus",
    "payment_status",
    "status",
  ]);
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s === "all") return null;
  return s;
}

/** Full-text-ish match across PaymentTransaction fields for `q` (ANDs with date, hospital, status filters). */
function buildTransactionSearchOrClause(q) {
  const trimmed = String(q).trim();
  if (!trimmed) return null;
  const regex = new RegExp(escapeRegex(trimmed), "i");
  const orClause = [
    { razorpayPaymentId: regex },
    { razorpayOrderId: regex },
    { razorpaySignature: regex },
    { patientNameSnapshot: regex },
    { patientPhoneSnapshot: regex },
    { hospitalNameSnapshot: regex },
    { appointmentIdDisplaySnapshot: regex },
    { paymentMethod: regex },
    { currency: regex },
    { recordedVia: regex },
    { internalNotes: regex },
    { termsVersion: regex },
    { razorpayStatus: regex },
    { clientIp: regex },
    { userAgent: regex },
  ];
  if (mongoose.isValidObjectId(trimmed)) {
    const oid = new mongoose.Types.ObjectId(trimmed);
    orClause.push({ _id: oid });
    orClause.push({ patient: oid });
    orClause.push({ hospital: oid });
    orClause.push({ appointment: oid });
    orClause.push({ recordedBy: oid });
  }
  const asNum = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(asNum) && String(asNum) === trimmed) {
    orClause.push({ amount: asNum });
  }
  return orClause;
}

/**
 * GET /api/payouts/transactions/search
 * Super admin only. At least one of: q, hospitalId, fromDate/toDate, or payment status filter.
 * `q` matches payment/order IDs, snapshots, status substring, method, notes, IPs, amounts (numeric), ObjectIds on linked refs.
 */
const searchTransactions = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const requestedHospital = String(req.query.hospitalId || "").trim();

    const { fromDate, toDate, hasDateRange } = getDateRangeFromQuery(req.query);

    const hasHospital = requestedHospital.length > 0;
    const hasQ = q.length > 0;
    const statusFilter = parseTxStatusFilter(req.query);
    const hasStatusOnly = Boolean(statusFilter);

    if (!hasQ && !hasHospital && !hasDateRange && !hasStatusOnly) {
      return res.status(400).json({
        success: false,
        message:
          "Provide q and/or hospitalId and/or fromDate & toDate (createdAt range) and/or status (razorpay payment status)",
      });
    }

    if (hasHospital && !mongoose.isValidObjectId(requestedHospital)) {
      return res.status(400).json({ success: false, message: "Invalid hospitalId" });
    }

    const filter = {};

    if (hasHospital) {
      filter.hospital = new mongoose.Types.ObjectId(requestedHospital);
    }

    if (hasDateRange) {
      const range = {};
      if (fromDate) {
        const g = parseCalendarDayStartUtc(fromDate);
        if (g) range.$gte = g;
      }
      if (toDate) {
        const lte = parseCalendarDayEndUtc(toDate);
        if (lte) range.$lte = lte;
      }
      if (Object.keys(range).length > 0) {
        filter.createdAt = range;
      }
    }

    if (statusFilter) {
      filter.razorpayStatus = new RegExp(`^${escapeRegex(statusFilter)}$`, "i");
    }

    if (hasQ) {
      const orClause = buildTransactionSearchOrClause(q);
      if (orClause && orClause.length) {
        filter.$or = orClause;
      }
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      PaymentTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentTransaction.countDocuments(filter),
    ]);

    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  patchTransactionStatus,
  patchPayoutListRecordStatus,
  searchTransactions,
};
