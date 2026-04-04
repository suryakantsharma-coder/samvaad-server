const { getReminderQueue } = require('../queues/reminder.queue');
const { schedulePrescriptionRemindersById } = require('../services/reminder.service');
const Prescription = require('../models/prescription.model');
const { mergeHospitalFilter } = require('../utils/hospitalScope');

/**
 * Unauthenticated read-by-id for patient-facing links (no hospital scope).
 * Patient phone is omitted from the payload.
 *
 * @route GET /api/public/prescriptions/:id
 */
const getPublicPrescriptionById = async (req, res, next) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patient', 'fullName patientId age gender')
      .populate('appointment', 'appointmentId reason appointmentDateTime status')
      .populate('hospital', 'name phoneCountryCode')
      .lean();

    if (!prescription) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    res.json({ success: true, data: { prescription } });
  } catch (err) {
    next(err);
  }
};

/**
 * Dashboard: sample jobs and aggregate counts for the medicine reminder queue.
 * @route GET /api/prescriptions/reminders/dashboard
 */
const getReminderQueueDashboard = async (req, res, next) => {
  try {
    const queue = getReminderQueue();
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
    );

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

    const [waiting, delayed, active, completed, failed] = await Promise.all([
      queue.getJobs(['waiting'], 0, limit - 1),
      queue.getJobs(['delayed'], 0, limit - 1),
      queue.getJobs(['active'], 0, limit - 1),
      queue.getJobs(['completed'], 0, limit - 1),
      queue.getJobs(['failed'], 0, limit - 1),
    ]);

    const serialize = (job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      delay: job.delay,
      failedReason: job.failedReason,
    });

    res.json({
      success: true,
      data: {
        queue: queue.name,
        counts,
        pending: {
          waiting: waiting.map(serialize),
          delayed: delayed.map(serialize),
          active: active.map(serialize),
        },
        completed: completed.map(serialize),
        failed: failed.map(serialize),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Manually (re)schedule reminder jobs for a prescription (same rules as on create).
 * Useful if Redis was down at creation time. Idempotent jobIds may skip duplicates.
 *
 * @route POST /api/prescriptions/:id/schedule-reminders
 */
const scheduleRemindersForPrescription = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    mergeHospitalFilter(req, filter);

    const exists = await Prescription.findOne(filter).select('_id').lean();
    if (!exists) {
      return res.status(404).json({ success: false, message: 'Prescription not found' });
    }

    const summary = await schedulePrescriptionRemindersById(req.params.id);
    res.json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getReminderQueueDashboard,
  scheduleRemindersForPrescription,
  getPublicPrescriptionById,
};
