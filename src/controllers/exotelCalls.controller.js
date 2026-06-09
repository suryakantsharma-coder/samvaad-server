const mongoose = require("mongoose");
const ExotelCall = require("../models/exotelCall.model");
const {
  syncExotelMonth,
  getCurrentUtcYearMonth,
  toMonthKey,
} = require("../services/exotelCalls.service");
const { toDigits } = require("../services/callAnalytics.service");

function parseYearMonth(req) {
  const yearRaw = req.query.year ?? req.body?.year;
  const monthRaw = req.query.month ?? req.body?.month;
  if (yearRaw == null || monthRaw == null) return null;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { error: "year/month invalid; month must be 1-12" };
  }
  return { year, month };
}

const syncCurrentMonth = async (_req, res, next) => {
  try {
    const { year, month } = getCurrentUtcYearMonth();
    const out = await syncExotelMonth({ year, month });
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
};

const syncByMonth = async (req, res, next) => {
  try {
    const ym = parseYearMonth(req);
    if (!ym || ym.error) {
      return res.status(400).json({ success: false, message: ym?.error || "year/month required" });
    }
    const out = await syncExotelMonth({ year: ym.year, month: ym.month });
    return res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
};

const createOne = async (req, res, next) => {
  try {
    const payload = { ...(req.body || {}) };
    if (!payload.sid || !String(payload.sid).trim()) {
      return res.status(400).json({ success: false, message: "sid is required" });
    }
    payload.sid = String(payload.sid).trim();
    payload.callSid = payload.callSid ? String(payload.callSid).trim() : payload.sid;
    const duration = Number(payload.duration || 0);
    payload.duration = duration;
    payload.creditUsed = Math.ceil(Math.max(0, duration) / 60);
    if (payload.phoneNumber) {
      payload.phoneNumberDigits = toDigits(payload.phoneNumber);
    }
    const doc = await ExotelCall.create(payload);
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
};

const list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.syncMonth) filter.syncMonth = String(req.query.syncMonth).trim();
    if (req.query.status) filter.status = String(req.query.status).trim();
    if (req.query.direction) filter.direction = String(req.query.direction).trim();
    if (req.query.from) filter.from = String(req.query.from).trim();

    const [items, total] = await Promise.all([
      ExotelCall.find(filter).sort({ dateCreated: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ExotelCall.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
      },
    });
  } catch (err) {
    next(err);
  }
};

const getById = async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    let doc = null;
    if (mongoose.isValidObjectId(id)) {
      doc = await ExotelCall.findById(id).lean();
    }
    if (!doc) {
      doc = await ExotelCall.findOne({ sid: id }).lean();
    }
    if (!doc) {
      return res.status(404).json({ success: false, message: "Exotel call not found" });
    }
    return res.json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
};

const updateById = async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    const payload = { ...(req.body || {}) };
    if (payload.duration !== undefined) {
      const duration = Number(payload.duration || 0);
      payload.duration = duration;
      payload.creditUsed = Math.ceil(Math.max(0, duration) / 60);
    }
    if (payload.phoneNumber !== undefined) {
      payload.phoneNumberDigits = toDigits(payload.phoneNumber);
    }
    if (payload.sid !== undefined) {
      payload.sid = String(payload.sid).trim();
      if (!payload.callSid) payload.callSid = payload.sid;
    }

    let doc = null;
    if (mongoose.isValidObjectId(id)) {
      doc = await ExotelCall.findByIdAndUpdate(id, { $set: payload }, { new: true, runValidators: true });
    } else {
      doc = await ExotelCall.findOneAndUpdate(
        { sid: id },
        { $set: payload },
        { new: true, runValidators: true }
      );
    }

    if (!doc) {
      return res.status(404).json({ success: false, message: "Exotel call not found" });
    }
    return res.json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
};

const removeById = async (req, res, next) => {
  try {
    const id = String(req.params.id || "");
    let deleted = null;
    if (mongoose.isValidObjectId(id)) {
      deleted = await ExotelCall.findByIdAndDelete(id);
    } else {
      deleted = await ExotelCall.findOneAndDelete({ sid: id });
    }
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Exotel call not found" });
    }
    return res.json({ success: true, message: "Deleted", data: { id: String(deleted._id), sid: deleted.sid } });
  } catch (err) {
    next(err);
  }
};

const getSummaryByMonth = async (req, res, next) => {
  try {
    const ym = parseYearMonth(req) || getCurrentUtcYearMonth();
    if (ym.error) {
      return res.status(400).json({ success: false, message: ym.error });
    }
    const syncMonth = toMonthKey(ym.year, ym.month);
    const [agg] = await ExotelCall.aggregate([
      { $match: { syncMonth } },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: "$duration" },
          answeredHuman: {
            $sum: {
              $cond: [{ $eq: [{ $toLower: "$answeredBy" }, "human"] }, 1, 0],
            },
          },
          inboundCalls: {
            $sum: {
              $cond: [{ $eq: [{ $toLower: "$direction" }, "inbound"] }, 1, 0],
            },
          },
        },
      },
    ]);
    return res.json({
      success: true,
      data: {
        syncMonth,
        totalCalls: agg?.totalCalls || 0,
        totalDuration: agg?.totalDuration || 0,
        answeredHuman: agg?.answeredHuman || 0,
        inboundCalls: agg?.inboundCalls || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  syncCurrentMonth,
  syncByMonth,
  createOne,
  list,
  getById,
  updateById,
  removeById,
  getSummaryByMonth,
};
