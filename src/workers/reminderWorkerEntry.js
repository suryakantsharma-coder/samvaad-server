/**
 * Standalone BullMQ worker process for horizontal scaling.
 * Usage: `npm run reminder-worker`
 *
 * Ensure REMINDER_WORKER_DISABLED is not set in `.env` for this process
 * (or override for this shell only).
 */
const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
});

// Keep reminder slot wall-clock times in the configured timezone.
if (!process.env.TZ) {
  process.env.TZ = (process.env.REMINDER_TIMEZONE || 'Asia/Kolkata').trim();
}

const connectDB = require('../config/db');
const { startReminderWorker, stopReminderWorker } = require('./reminder.worker');
const {
  startDoctorHolidayWorker,
  stopDoctorHolidayWorker,
} = require('./doctorHoliday.worker');
const {
  startAppointmentConfirmationWorker,
  stopAppointmentConfirmationWorker,
} = require('./appointmentConfirmation.worker');
const { closeReminderQueue } = require('../queues/reminder.queue');
const { closeDoctorHolidayQueue } = require('../queues/doctorHoliday.queue');
const {
  closeAppointmentConfirmationQueue,
} = require('../queues/appointmentConfirmation.queue');

let exiting = false;

async function graceful(signal) {
  if (exiting) return;
  exiting = true;
  console.log(`[Reminder] ${signal} received, closing worker…`);
  try {
    await stopReminderWorker();
  } catch (err) {
    console.error('[Reminder] Worker stop error:', err.message);
  }
  try {
    await stopDoctorHolidayWorker();
  } catch (err) {
    console.error('[DoctorHoliday] Worker stop error:', err.message);
  }
  try {
    await stopAppointmentConfirmationWorker();
  } catch (err) {
    console.error('[ApptConfirm] Worker stop error:', err.message);
  }
  try {
    await closeReminderQueue();
  } catch (err) {
    console.error('[Reminder] Queue close error:', err.message);
  }
  try {
    await closeDoctorHolidayQueue();
  } catch (err) {
    console.error('[DoctorHoliday] Queue close error:', err.message);
  }
  try {
    await closeAppointmentConfirmationQueue();
  } catch (err) {
    console.error('[ApptConfirm] Queue close error:', err.message);
  }
  process.exit(0);
}

process.once('SIGINT', () => graceful('SIGINT'));
process.once('SIGTERM', () => graceful('SIGTERM'));

connectDB()
  .then(async () => {
    const w = await startReminderWorker();
    if (!w) {
      console.error('[Reminder] Standalone worker did not start (check Redis). Exiting.');
      process.exit(1);
    }
    const h = await startDoctorHolidayWorker();
    const c = await startAppointmentConfirmationWorker();
    console.log('[Reminder] Standalone workers ready', {
      reminders: true,
      doctorHolidays: Boolean(h),
      appointmentConfirmations: Boolean(c),
    });
  })
  .catch((err) => {
    console.error('[Reminder] Startup failed:', err);
    process.exit(1);
  });
