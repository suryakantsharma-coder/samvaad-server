const mongoose = require("mongoose");
const Hospital = require("../models/hospital.model");
const ExotelCall = require("../models/exotelCall.model");

function toDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function pad2(v) {
  return String(v).padStart(2, "0");
}

function getCurrentLocalYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function getMonthRangeLocal(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(end.getDate())}`,
  };
}

/**
 * Super admin: monthly buckets (year+month). Admin: optional custom range or month.
 * When nothing is passed, defaults to the current calendar month (local TZ).
 */
function resolveAnalyticsDateRange({ startDate, endDate, year, month }) {
  const hasYear = year != null && String(year).trim() !== "";
  const hasMonth = month != null && String(month).trim() !== "";

  if (hasYear || hasMonth) {
    if (!hasYear || !hasMonth) {
      return { error: "Both year and month are required for monthly analytics" };
    }
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      return { error: "year/month invalid; month must be 1-12" };
    }
    const range = getMonthRangeLocal(y, m);
    return {
      startDate: range.startDate,
      endDate: range.endDate,
      year: y,
      month: m,
      period: "month",
    };
  }

  if (startDate || endDate) {
    return {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      period: "range",
    };
  }

  const current = getCurrentLocalYearMonth();
  const range = getMonthRangeLocal(current.year, current.month);
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    year: current.year,
    month: current.month,
    period: "month",
    defaulted: true,
  };
}

function parseDateBoundaries({ startDate, endDate }) {
  const out = {};
  if (startDate) {
    const s = new Date(startDate);
    if (!Number.isNaN(s.getTime())) out.$gte = s;
  }
  if (endDate) {
    const e = new Date(endDate);
    if (!Number.isNaN(e.getTime())) {
      e.setHours(23, 59, 59, 999);
      out.$lte = e;
    }
  }
  return Object.keys(out).length ? out : null;
}

function buildAnsweredExpr() {
  return {
    $or: [
      { $eq: [{ $toLower: { $ifNull: ["$answeredBy", ""] } }, "human"] },
      { $in: [{ $toLower: { $ifNull: ["$status", ""] } }, ["completed", "answered"]] },
    ],
  };
}

function buildMissedExpr() {
  return {
    $or: [
      { $eq: [{ $toLower: { $ifNull: ["$status", ""] } }, "missed"] },
      { $eq: [{ $toLower: { $ifNull: ["$status", ""] } }, "no-answer"] },
    ],
  };
}

function summaryProjection() {
  return {
    _id: 0,
    totalCalls: 1,
    totalDuration: 1,
    totalCreditsUsed: 1,
    answeredCalls: 1,
    missedCalls: 1,
    averageCallDuration: {
      $cond: [{ $gt: ["$totalCalls", 0] }, { $divide: ["$totalDuration", "$totalCalls"] }, 0],
    },
  };
}

function buildCommonSummaryGroup() {
  return {
    _id: null,
    totalCalls: { $sum: 1 },
    totalDuration: { $sum: { $ifNull: ["$duration", 0] } },
    totalCreditsUsed: { $sum: { $ifNull: ["$creditUsed", 0] } },
    answeredCalls: { $sum: { $cond: [buildAnsweredExpr(), 1, 0] } },
    missedCalls: { $sum: { $cond: [buildMissedExpr(), 1, 0] } },
  };
}

async function getSuperAdminHospitalWiseAnalytics({ startDate, endDate, hospitalId }) {
  const hospitalFilter = {};
  if (hospitalId) hospitalFilter._id = new mongoose.Types.ObjectId(hospitalId);

  const hospitals = await Hospital.find(hospitalFilter)
    .select("_id name voiceAgentNumber")
    .lean();

  const dateRange = parseDateBoundaries({ startDate, endDate });
  const out = [];

  for (const h of hospitals) {
    const voiceAgentNumber = String(h.voiceAgentNumber || "").trim();
    const voiceDigits = toDigits(voiceAgentNumber);
    const match = {};
    if (dateRange) match.dateCreated = dateRange;

    if (voiceDigits) {
      match.$or = [
        { phoneNumber: voiceAgentNumber },
        { phoneNumber: voiceDigits },
        { phoneNumberDigits: voiceDigits },
      ];
    } else {
      match._id = null;
    }

    const [agg] = await ExotelCall.aggregate([
      { $match: match },
      { $group: buildCommonSummaryGroup() },
      { $project: summaryProjection() },
    ]);

    out.push({
      hospitalId: String(h._id),
      hospitalName: h.name || "",
      voiceAgentNumber: voiceAgentNumber || "",
      totalCalls: agg?.totalCalls || 0,
      totalDuration: agg?.totalDuration || 0,
      totalCreditsUsed: agg?.totalCreditsUsed || 0,
      answeredCalls: agg?.answeredCalls || 0,
      missedCalls: agg?.missedCalls || 0,
      averageCallDuration: agg?.averageCallDuration || 0,
    });
  }

  return out;
}

async function getHospitalCallAnalyticsDetails({
  hospitalId,
  startDate,
  endDate,
  page = 1,
  limit = 20,
}) {
  const hospital = await Hospital.findById(hospitalId).select("_id name voiceAgentNumber").lean();
  if (!hospital) {
    const err = new Error("Hospital not found");
    err.statusCode = 404;
    throw err;
  }

  const voiceAgentNumber = String(hospital.voiceAgentNumber || "").trim();
  const voiceDigits = toDigits(voiceAgentNumber);
  if (!voiceDigits) {
    return {
      hospitalId: String(hospital._id),
      hospitalName: hospital.name || "",
      voiceAgentNumber: voiceAgentNumber || "",
      totals: {
        totalCalls: 0,
        totalDuration: 0,
        totalCreditsUsed: 0,
        answeredCalls: 0,
        missedCalls: 0,
        averageCallDuration: 0,
      },
      calls: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
    };
  }

  const skip = (page - 1) * limit;
  const dateRange = parseDateBoundaries({ startDate, endDate });
  const match = {
    $or: [
      { phoneNumber: voiceAgentNumber },
      { phoneNumber: voiceDigits },
      { phoneNumberDigits: voiceDigits },
    ],
  };
  if (dateRange) match.dateCreated = dateRange;

  const [totalsAgg] = await ExotelCall.aggregate([
    { $match: match },
    { $group: buildCommonSummaryGroup() },
    { $project: summaryProjection() },
  ]);

  const [calls, total] = await Promise.all([
    ExotelCall.find(match).sort({ dateCreated: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ExotelCall.countDocuments(match),
  ]);

  return {
    hospitalId: String(hospital._id),
    hospitalName: hospital.name || "",
    voiceAgentNumber: voiceAgentNumber || "",
    totals: {
      totalCalls: totalsAgg?.totalCalls || 0,
      totalDuration: totalsAgg?.totalDuration || 0,
      totalCreditsUsed: totalsAgg?.totalCreditsUsed || 0,
      answeredCalls: totalsAgg?.answeredCalls || 0,
      missedCalls: totalsAgg?.missedCalls || 0,
      averageCallDuration: totalsAgg?.averageCallDuration || 0,
    },
    calls,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
  };
}

module.exports = {
  toDigits,
  getCurrentLocalYearMonth,
  getMonthRangeLocal,
  resolveAnalyticsDateRange,
  getSuperAdminHospitalWiseAnalytics,
  getHospitalCallAnalyticsDetails,
};
