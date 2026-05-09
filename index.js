const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const { startLiveKitWorker, stopLiveKitWorker } = require('./src/startLiveKitWorker');
const { startReminderWorker, stopReminderWorker } = require('./src/workers/reminder.worker');
const {
  startDoctorHolidayWorker,
  stopDoctorHolidayWorker,
} = require('./src/workers/doctorHoliday.worker');
const { startPostCallWorker, stopPostCallWorker } = require('./src/workers/postCallWorker');
const {
  startHourlyPayoutCron,
  stopHourlyPayoutCron,
} = require('./src/cron/hourlyPayout/hourlyPayoutCron');
const { closeReminderQueue } = require('./src/queues/reminder.queue');
const { closeDoctorHolidayQueue } = require('./src/queues/doctorHoliday.queue');
const { closePostCallQueue } = require('./src/queues/postCallQueue');

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Samvaad] Shutting down (${signal})`);
  try {
    await stopReminderWorker();
  } catch (err) {
    console.error('[Samvaad] Reminder worker stop:', err.message);
  }
  try {
    await stopDoctorHolidayWorker();
  } catch (err) {
    console.error('[Samvaad] Doctor holiday worker stop:', err.message);
  }
  try {
    await stopPostCallWorker();
  } catch (err) {
    console.error('[Samvaad] Post-call worker stop:', err.message);
  }
  try {
    stopHourlyPayoutCron();
  } catch (err) {
    console.error('[Samvaad] Hourly payout cron stop:', err.message);
  }
  try {
    await closeReminderQueue();
  } catch (err) {
    console.error('[Samvaad] Reminder queue close:', err.message);
  }
  try {
    await closeDoctorHolidayQueue();
  } catch (err) {
    console.error('[Samvaad] Doctor holiday queue close:', err.message);
  }
  try {
    await closePostCallQueue();
  } catch (err) {
    console.error('[Samvaad] Post-call queue close:', err.message);
  }
  stopLiveKitWorker();
  process.exit(0);
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});

const start = async () => {
  await connectDB();

  const ks = env.RAZORPAY_KEY_SECRET && String(env.RAZORPAY_KEY_SECRET).trim();
  const ws = env.RAZORPAY_WEBHOOK_SECRET && String(env.RAZORPAY_WEBHOOK_SECRET).trim();
  if (ks && ws && ks === ws) {
    console.warn(
      '[Samvaad] RAZORPAY_WEBHOOK_SECRET equals RAZORPAY_KEY_SECRET. Webhook HMAC uses a different secret from Dashboard → Account & Settings → Webhooks → your endpoint.'
    );
  }
  if (!ws && env.RAZORPAY_KEY_ID) {
    console.warn('[Samvaad] RAZORPAY_WEBHOOK_SECRET is empty — webhook signature verification will fail until you set it.');
  }

  const server = app.listen(env.PORT, async () => {
    console.log(`[Samvaad] Server running on port ${env.PORT} (${env.NODE_ENV})`);
    startLiveKitWorker();
    /* For multiple worker processes: set REMINDER_WORKER_DISABLED=1 here and run `npm run reminder-worker`. */
    await startReminderWorker();
    await startDoctorHolidayWorker();
    await startPostCallWorker();
    console.log('[Samvaad] Starting hourly payout cron…');
    startHourlyPayoutCron();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[Samvaad] Port ${env.PORT} is already in use (another process is listening).`
      );
      console.error(
        `[Samvaad] Fix: close that terminal / stop the old server, or run: lsof -i :${env.PORT}  then  kill <PID>`
      );
      console.error(`[Samvaad] Or use a different port: PORT=3001 npm run dev`);
    } else {
      console.error('[Samvaad] HTTP server error:', err.message);
    }
    process.exit(1);
  });
};

start().catch((err) => {
  console.error('[Samvaad] Failed to start:', err);
  process.exit(1);
});
