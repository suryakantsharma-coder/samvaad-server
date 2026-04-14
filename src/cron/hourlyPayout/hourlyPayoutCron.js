const cron = require("node-cron");
const { runHourlyPayoutJob } = require("./runHourlyPayoutJob");

let scheduledTask = null;

function startHourlyPayoutCron() {
  console.log("[HourlyPayout] startHourlyPayoutCron: entering");
  if (process.env.HOURLY_PAYOUT_CRON_DISABLED === "1") {
    console.log("[HourlyPayout] Cron disabled (HOURLY_PAYOUT_CRON_DISABLED=1); skipping schedule");
    return;
  }
  if (scheduledTask) {
    console.log("[HourlyPayout] Cron already running; skip duplicate start");
    return;
  }

  const options = {};
  if (process.env.TZ) {
    options.timezone = process.env.TZ;
    console.log(`[HourlyPayout] Cron timezone: ${process.env.TZ}`);
  } else {
    console.log("[HourlyPayout] Cron timezone: system default (TZ not set)");
  }

  console.log('[HourlyPayout] Registering schedule: "0 * * * *" (every hour at minute 0)');

  scheduledTask = cron.schedule(
    "0 * * * *",
    async () => {
      const tickAt = new Date().toISOString();
      console.log(`[HourlyPayout] Cron tick fired at ${tickAt}`);
      try {
        const meta = await runHourlyPayoutJob();
        console.log(
          `[HourlyPayout] Cron tick finished OK — hospitals=${meta.hospitals} period=${meta.periodStart.toISOString()} … ${meta.periodEnd.toISOString()} runAt=${meta.runAt.toISOString()}`
        );
      } catch (err) {
        console.error("[HourlyPayout] Cron tick failed:", err.message);
        if (err.stack) console.error(err.stack);
      }
    },
    options
  );

  console.log("[HourlyPayout] Cron scheduled successfully (every hour at :00)");
}

function stopHourlyPayoutCron() {
  console.log("[HourlyPayout] stopHourlyPayoutCron: entering");
  if (scheduledTask) {
    console.log("[HourlyPayout] Stopping scheduled task…");
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[HourlyPayout] Cron stopped");
  } else {
    console.log("[HourlyPayout] No scheduled task to stop");
  }
}

module.exports = { startHourlyPayoutCron, stopHourlyPayoutCron };
