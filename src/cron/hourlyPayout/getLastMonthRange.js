/**
 * Previous calendar month: day 1 00:00:00 through last day 23:59:59.999 (local time).
 */
function getLastMonthRange() {
  console.log("[HourlyPayout] getLastMonthRange: start");
  const now = new Date();
  console.log(`[HourlyPayout] getLastMonthRange: now=${now.toISOString()} localY=${now.getFullYear()} localM=${now.getMonth()}`);

  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  console.log(`[HourlyPayout] getLastMonthRange: first day of previous month → start=${start.toISOString()}`);

  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
  console.log(
    `[HourlyPayout] getLastMonthRange: last calendar day of previous month (midnight) → lastDay=${lastDay.toISOString()}`
  );

  const end = new Date(
    lastDay.getFullYear(),
    lastDay.getMonth(),
    lastDay.getDate(),
    23,
    59,
    59,
    999
  );
  console.log(`[HourlyPayout] getLastMonthRange: end of last day (inclusive) → end=${end.toISOString()}`);

  console.log("[HourlyPayout] getLastMonthRange: returning { start, end }");
  return { start, end };
}

/**
 * Current calendar month: day 1 00:00:00 through last day 23:59:59.999 (local time).
 * For testing when `PAYOUT_CRON_USE_CURRENT_MONTH` is enabled.
 */
function getCurrentMonthRange() {
  console.log("[HourlyPayout] getCurrentMonthRange: start");
  const now = new Date();
  console.log(`[HourlyPayout] getCurrentMonthRange: now=${now.toISOString()} localY=${now.getFullYear()} localM=${now.getMonth()}`);

  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  console.log(`[HourlyPayout] getCurrentMonthRange: first day of this month → start=${start.toISOString()}`);

  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  console.log(
    `[HourlyPayout] getCurrentMonthRange: last calendar day of this month (midnight) → lastDay=${lastDay.toISOString()}`
  );

  const end = new Date(
    lastDay.getFullYear(),
    lastDay.getMonth(),
    lastDay.getDate(),
    23,
    59,
    59,
    999
  );
  console.log(`[HourlyPayout] getCurrentMonthRange: end of last day (inclusive) → end=${end.toISOString()}`);

  console.log("[HourlyPayout] getCurrentMonthRange: returning { start, end }");
  return { start, end };
}

module.exports = { getLastMonthRange, getCurrentMonthRange };
