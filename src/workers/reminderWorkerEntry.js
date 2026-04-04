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
const { closeReminderQueue } = require('../queues/reminder.queue');

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
    await closeReminderQueue();
  } catch (err) {
    console.error('[Reminder] Queue close error:', err.message);
  }
  process.exit(0);
}

process.once('SIGINT', () => graceful('SIGINT'));
process.once('SIGTERM', () => graceful('SIGTERM'));

connectDB()
  .then(async () => {
    const w = await startReminderWorker();
    if (w) {
      console.log('[Reminder] Standalone worker ready');
    } else {
      console.error('[Reminder] Standalone worker did not start (check Redis). Exiting.');
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('[Reminder] Startup failed:', err);
    process.exit(1);
  });
