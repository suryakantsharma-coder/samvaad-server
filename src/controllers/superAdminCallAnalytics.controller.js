const {
  getSuperAdminHospitalWiseAnalytics,
  getHospitalCallAnalyticsDetails,
  resolveAnalyticsDateRange,
} = require("../services/callAnalytics.service");

const listHospitalAnalytics = async (req, res, next) => {
  try {
    const { startDate, endDate, hospitalId, year, month } = req.query;
    const resolved = resolveAnalyticsDateRange({ startDate, endDate, year, month });
    if (resolved.error) {
      return res.status(400).json({ success: false, message: resolved.error });
    }

    const data = await getSuperAdminHospitalWiseAnalytics({
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      hospitalId,
    });
    return res.json({
      success: true,
      data,
      meta: {
        period: resolved.period,
        startDate: resolved.startDate,
        endDate: resolved.endDate,
        year: resolved.year,
        month: resolved.month,
        defaulted: resolved.defaulted || false,
      },
    });
  } catch (err) {
    next(err);
  }
};

const getHospitalAnalyticsDetails = async (req, res, next) => {
  try {
    const { hospitalId } = req.params;
    const { startDate, endDate, year, month } = req.query;
    const resolved = resolveAnalyticsDateRange({ startDate, endDate, year, month });
    if (resolved.error) {
      return res.status(400).json({ success: false, message: resolved.error });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));

    const data = await getHospitalCallAnalyticsDetails({
      hospitalId,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      page,
      limit,
    });

    return res.json({
      success: true,
      data,
      meta: {
        period: resolved.period,
        startDate: resolved.startDate,
        endDate: resolved.endDate,
        year: resolved.year,
        month: resolved.month,
        defaulted: resolved.defaulted || false,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listHospitalAnalytics,
  getHospitalAnalyticsDetails,
};
