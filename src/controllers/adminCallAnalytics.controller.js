const {
  getHospitalCallAnalyticsDetails,
  resolveAnalyticsDateRange,
} = require("../services/callAnalytics.service");
const { getExotelDailySyncStatus } = require("../cron/exotel/exotelDailySyncCron");

const getOwnHospitalAnalytics = async (req, res, next) => {
  try {
    const hospitalId = req.user?.hospital;
    if (!hospitalId) {
      return res.status(403).json({
        success: false,
        message: "Admin user is not linked to a hospital",
      });
    }

    const { startDate, endDate, year, month } = req.query;
    const resolved = resolveAnalyticsDateRange({ startDate, endDate, year, month });
    if (resolved.error) {
      return res.status(400).json({ success: false, message: resolved.error });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));

    const data = await getHospitalCallAnalyticsDetails({
      hospitalId: String(hospitalId),
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
        exotelSync: getExotelDailySyncStatus(),
      },
    });
  } catch (err) {
    next(err);
  }
};

const getExotelSyncStatus = async (_req, res) => {
  return res.json({
    success: true,
    data: getExotelDailySyncStatus(),
  });
};

module.exports = {
  getOwnHospitalAnalytics,
  getExotelSyncStatus,
};
