/**
 * Doctor holiday ranges: calendar-day logic in the server's local timezone
 * (matches WhatsApp `parseFlexibleDate` / `toYyyyMmDd`).
 */

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * @param {Date|string|number} v
 * @returns {string} YYYY-MM-DD (local calendar)
 */
function toYyyyMmDdLocal(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {Date|string|number} v
 * @returns {string} e.g. "12 Apr 2026"
 */
function formatHolidayEndForUser(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Inclusive range: appointmentYmd is blocked if startYmd <= appointmentYmd <= endYmd.
 * @param {string} appointmentYmd
 * @param {{ startDate?: Date, endDate?: Date }} h
 * @returns {boolean}
 */
function holidayRangeCoversYmd(appointmentYmd, h) {
  if (!h || !h.startDate || !h.endDate) return false;
  const start = toYyyyMmDdLocal(h.startDate);
  const end = toYyyyMmDdLocal(h.endDate);
  if (!start || !end) return false;
  return appointmentYmd >= start && appointmentYmd <= end;
}

/**
 * @param {Array<{ startDate?: Date, endDate?: Date }>} holidays
 * @param {string} appointmentYmd
 * @returns {{ endDate: Date, endLabel: string } | null}
 */
function findHolidayCoveringYmd(holidays, appointmentYmd) {
  if (!Array.isArray(holidays) || !appointmentYmd) return null;
  for (const h of holidays) {
    if (holidayRangeCoversYmd(appointmentYmd, h)) {
      const end = h.endDate instanceof Date ? h.endDate : new Date(h.endDate);
      if (Number.isNaN(end.getTime())) continue;
      return { endDate: end, endLabel: formatHolidayEndForUser(end) };
    }
  }
  return null;
}

/**
 * @param {Date|string|number} startDate
 * @param {Date|string|number} endDate
 * @returns {number} ms from now until local midnight at start of startDate (clamped 0)
 */
function msUntilLocalStartOfHolidayDay(startDate) {
  const d = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(d.getTime())) return 0;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return Math.max(0, start.getTime() - Date.now());
}

/**
 * Last holiday day is endDate; return to On Duty at local midnight of the following day.
 * @param {Date|string|number} endDate
 * @returns {number}
 */
function msUntilLocalMidnightAfterHolidayEnd(endDate) {
  const d = endDate instanceof Date ? endDate : new Date(endDate);
  if (Number.isNaN(d.getTime())) return 0;
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - Date.now());
}

/**
 * Whether "now" falls inside any holiday range (local calendar, inclusive).
 * @param {Array<{ startDate?: Date, endDate?: Date }>} holidays
 * @param {Date} [now]
 * @returns {boolean}
 */
function isNowInsideAnyHoliday(holidays, now = new Date()) {
  const ymd = toYyyyMmDdLocal(now);
  return findHolidayCoveringYmd(holidays, ymd) != null;
}

module.exports = {
  toYyyyMmDdLocal,
  formatHolidayEndForUser,
  holidayRangeCoversYmd,
  findHolidayCoveringYmd,
  msUntilLocalStartOfHolidayDay,
  msUntilLocalMidnightAfterHolidayEnd,
  isNowInsideAnyHoliday,
};
