const {
  getSuperAdminHospitalWiseAnalytics,
  getHospitalCallAnalyticsDetails,
} = require("../services/callAnalytics.service");

const listHospitalAnalytics = async (req, res, next) => {
  try {
    const { startDate, endDate, hospitalId } = req.query;
    const data = await getSuperAdminHospitalWiseAnalytics({
      startDate,
      endDate,
      hospitalId,
    });
    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const getHospitalAnalyticsDetails = async (req, res, next) => {
  try {
    const { hospitalId } = req.params;
    const { startDate, endDate } = req.query;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));

    const data = await getHospitalCallAnalyticsDetails({
      hospitalId,
      startDate,
      endDate,
      page,
      limit,
    });

    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listHospitalAnalytics,
  getHospitalAnalyticsDetails,
};
