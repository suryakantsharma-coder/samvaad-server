const cron = require("node-cron");
const { syncExotelMonth, getCurrentLocalYearMonth } = require("../../services/exotelCalls.service");

let scheduledTask = null;

function startExotelMonthlySyncCron() {
  if (process.env.EXOTEL_MONTHLY_SYNC_CRON_DISABLED === "1") {
    console.log("[ExotelCron] Disabled (EXOTEL_MONTHLY_SYNC_CRON_DISABLED=1)");
    return;
  }
  if (scheduledTask) {
    console.log("[ExotelCron] Already running; skip duplicate start");
    return;
  }

  const options = {};
  if (process.env.TZ) options.timezone = process.env.TZ;

  // Run at 00:10 on day 1 of each month.
  scheduledTask = cron.schedule(
    "10 0 1 * *",
    async () => {
      try {
        const { year, month } = getCurrentLocalYearMonth();
        const out = await syncExotelMonth({ year, month });
        console.log("[ExotelCron] Monthly sync success", out);
      } catch (err) {
        console.error("[ExotelCron] Monthly sync failed:", err.message);
      }
    },
    options
  );

  console.log('[ExotelCron] Scheduled: "10 0 1 * *"');
}

function stopExotelMonthlySyncCron() {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  console.log("[ExotelCron] Stopped");
}

module.exports = {
  startExotelMonthlySyncCron,
  stopExotelMonthlySyncCron,
};
