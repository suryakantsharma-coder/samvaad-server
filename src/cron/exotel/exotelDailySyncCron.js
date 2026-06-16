const cron = require("node-cron");
const {
  syncExotelMonth,
  getCurrentLocalYearMonth,
} = require("../../services/exotelCalls.service");

let scheduledTask = null;
let lastDailySyncAt = null;
let lastDailySyncResult = null;
let lastDailySyncError = null;

const DEFAULT_SCHEDULE = "0 2 * * *";

async function runExotelDailySyncJob() {
  const { year, month } = getCurrentLocalYearMonth();
  const out = await syncExotelMonth({ year, month });
  lastDailySyncAt = new Date();
  lastDailySyncResult = out;
  lastDailySyncError = null;
  return out;
}

function getExotelDailySyncStatus() {
  return {
    schedule: process.env.EXOTEL_DAILY_SYNC_CRON_SCHEDULE || DEFAULT_SCHEDULE,
    timezone: process.env.TZ || "system default",
    lastSyncAt: lastDailySyncAt,
    lastSyncResult: lastDailySyncResult,
    lastSyncError: lastDailySyncError,
  };
}

function startExotelDailySyncCron() {
  if (process.env.EXOTEL_DAILY_SYNC_CRON_DISABLED === "1") {
    console.log("[ExotelDailyCron] Disabled (EXOTEL_DAILY_SYNC_CRON_DISABLED=1)");
    return;
  }
  if (scheduledTask) {
    console.log("[ExotelDailyCron] Already running; skip duplicate start");
    return;
  }

  const schedule = process.env.EXOTEL_DAILY_SYNC_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const options = {};
  if (process.env.TZ) options.timezone = process.env.TZ;

  scheduledTask = cron.schedule(
    schedule,
    async () => {
      try {
        const out = await runExotelDailySyncJob();
        console.log("[ExotelDailyCron] Daily sync success", out);
      } catch (err) {
        lastDailySyncError = err.message;
        console.error("[ExotelDailyCron] Daily sync failed:", err.message);
      }
    },
    options
  );

  console.log(`[ExotelDailyCron] Scheduled: "${schedule}" (current month, local TZ)`);
}

function stopExotelDailySyncCron() {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[ExotelDailyCron] Stopped");
}

module.exports = {
  runExotelDailySyncJob,
  getExotelDailySyncStatus,
  startExotelDailySyncCron,
  stopExotelDailySyncCron,
};
