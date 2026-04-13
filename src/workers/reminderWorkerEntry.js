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

const connectDB = require('../config/db');
const { startReminderWorker, stopReminderWorker } = require('./reminder.worker');
const {
  startDoctorHolidayWorker,
  stopDoctorHolidayWorker,
} = require('./doctorHoliday.worker');
const { closeReminderQueue } = require('../queues/reminder.queue');
const { closeDoctorHolidayQueue } = require('../queues/doctorHoliday.queue');

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
    await closeReminderQueue();
  } catch (err) {
    console.error('[Reminder] Queue close error:', err.message);
  }
  try {
    await closeDoctorHolidayQueue();
  } catch (err) {
    console.error('[DoctorHoliday] Queue close error:', err.message);
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
    if (h) {
      console.log('[Reminder] Standalone workers ready (reminders + doctor holidays)');
    } else {
      console.warn('[Reminder] Doctor holiday worker did not start (see logs). Reminders only.');
    }
  })
  .catch((err) => {
    console.error('[Reminder] Startup failed:', err);
    process.exit(1);
  });
