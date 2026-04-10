const env = require("../config/env");
const {
  getCalendarConnectionStatus,
  generateGoogleAuthUrlForHospital,
} = require("../services/googleMeet.service");
const { getLinkedHospitalForResponse } = require("../utils/hospitalScope");

/**
 * GET /api/hospitals/:hospitalId/google-calendar/status
 */
const getStatus = async (req, res, next) => {
  try {
    const status = await getCalendarConnectionStatus(req.params.hospitalId);
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: status,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/hospitals/:hospitalId/google-calendar/auth-url
 */
const getAuthUrl = async (req, res, next) => {
  try {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
      return res.status(503).json({
        success: false,
        message:
          "Google OAuth is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)",
      });
    }
    const authUrl = generateGoogleAuthUrlForHospital(req.params.hospitalId);
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { authUrl },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getStatus,
  getAuthUrl,
};
