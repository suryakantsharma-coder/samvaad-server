/**
 * Date-only strings (YYYY-MM-DD) are interpreted as **Asia/Kolkata** calendar days,
 * converted to UTC instants for MongoDB (aligned with appointment booking IST semantics).
 *
 * `filter=today` / `filter=tomorrow` use the same IST calendar semantics (not UTC midnight).
 */

const RANGE_TZ_OFFSET = "+05:30";
const IST_TIME_ZONE = "Asia/Kolkata";

/** @param {Date | number} date @returns {string} YYYY-MM-DD in Asia/Kolkata */
function formatCalendarDateIST(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date instanceof Date ? date : new Date(date));
}

/** Mongo `$gte` / `$lte` for the IST calendar day that contains `date`. */
function istCalendarDayRangeContaining(date) {
  const dayKey = formatCalendarDateIST(date);
  const start = parseCalendarDayStartUtc(dayKey);
  const end = parseCalendarDayEndUtc(dayKey);
  if (!start || !end) return null;
  return { $gte: start, $lte: end };
}

/** Start/end of “today” in India (IST), as UTC instants for `appointmentDateTime` / etc. */
function istTodayRange() {
  const r = istCalendarDayRangeContaining(new Date());
  if (!r) throw new Error("istTodayRange: could not resolve Asia/Kolkata day bounds");
  return r;
}

/**
 * Next IST calendar day after “today” in India. Uses +24h from IST midnight (India has no DST).
 */
function istTomorrowRange() {
  const todayKey = formatCalendarDateIST(new Date());
  const todayStart = parseCalendarDayStartUtc(todayKey);
  if (!todayStart) return istTodayRange();
  const nextIstMidnightUtc = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayKey = formatCalendarDateIST(nextIstMidnightUtc);
  const start = parseCalendarDayStartUtc(dayKey);
  const end = parseCalendarDayEndUtc(dayKey);
  if (!start || !end) return istTodayRange();
  return { $gte: start, $lte: end };
}

/** @param {Record<string, unknown>} query @param {string[]} keys */
function firstTrimmedQueryValue(query, keys) {
  if (!query || !keys || !keys.length) return null;
  for (const k of keys) {
    const v = query[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function parseCalendarDayStartUtc(dateStr) {
  const raw = String(dateStr).trim();
  const day = raw.includes("T") ? raw.split("T")[0] : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(`${day}T00:00:00.000${RANGE_TZ_OFFSET}`);
}

function parseCalendarDayEndUtc(dateStr) {
  const raw = String(dateStr).trim();
  const day = raw.includes("T") ? raw.split("T")[0] : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(`${day}T23:59:59.999${RANGE_TZ_OFFSET}`);
}

/**
 * @param {Record<string, unknown>} query
 * @returns {{ fromDate: string|null, toDate: string|null, hasDateRange: boolean }}
 */
function getDateRangeFromQuery(query) {
  const fromDate = firstTrimmedQueryValue(query, [
    "fromDate",
    "from_date",
    "startDate",
    "start_date",
  ]);
  const toDate = firstTrimmedQueryValue(query, [
    "toDate",
    "to_date",
    "endDate",
    "end_date",
  ]);
  return {
    fromDate,
    toDate,
    hasDateRange: Boolean(fromDate || toDate),
  };
}

module.exports = {
  getDateRangeFromQuery,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
  firstTrimmedQueryValue,
  formatCalendarDateIST,
  istTodayRange,
  istTomorrowRange,
};
