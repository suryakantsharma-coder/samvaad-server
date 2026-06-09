const {
  getHospitalCallAnalyticsDetails,
} = require("../services/callAnalytics.service");

const getOwnHospitalAnalytics = async (req, res, next) => {
  try {
    const hospitalId = req.user?.hospital;
    if (!hospitalId) {
      return res.status(403).json({
        success: false,
        message: "Admin user is not linked to a hospital",
      });
    }

    const { startDate, endDate } = req.query;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));

    const data = await getHospitalCallAnalyticsDetails({
      hospitalId: String(hospitalId),
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
  getOwnHospitalAnalytics,
};
