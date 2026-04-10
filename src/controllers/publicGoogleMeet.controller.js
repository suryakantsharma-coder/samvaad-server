const { createMeetLink } = require("../services/googleMeet.service");

/**
 * POST /api/public/google-meet
 * Public — creates a Google Meet via Calendar API (OAuth).
 */
const createMeet = async (req, res, next) => {
  try {
    const { hospitalId, email, startTime, endTime, summary, description } = req.body;
    const meetLink = await createMeetLink({
      hospitalId,
      email,
      startTime,
      endTime,
      summary,
      description,
    });
    res.json({
      success: true,
      data: {
        meetLink,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { createMeet };
