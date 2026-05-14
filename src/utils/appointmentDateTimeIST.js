/**
 * India (IST, UTC+5:30) wall-clock parsing/formatting for appointment booking.
 * MongoDB stores an absolute instant; these helpers interpret and display IST.
 */

/**
 * Interprets the booking datetime as **India (IST, UTC+5:30) wall-clock**, then returns the stored UTC `Date`.
 * Trailing `Z` is stripped so values like `2026-04-09T05:00:00.000Z` mean **05:00 on that date in IST**, not UTC.
 * If the string already includes a non-Z timezone offset, it is parsed as-is.
 * @param {string|Date|null|undefined} raw
 * @returns {Date}
 */
function parseAppointmentDateTimeAsIST(raw) {
  if (raw instanceof Date) return raw;
  if (raw == null) return new Date(NaN);
  const s = String(raw).trim();
  if (!s) return new Date(NaN);

  if (/[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    return new Date(s);
  }

  const withoutZ = s.replace(/Z$/i, "");
  const isoLocal = withoutZ.includes("T") ? withoutZ : `${withoutZ}T00:00:00`;
  return new Date(`${isoLocal}+05:30`);
}

/**
 * @param {Date} d
 * @returns {string|null} e.g. 2026-02-12T17:30:00+05:30
 */
function formatInstantAsISTIso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const wall = d.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
  const [datePart, timePart] = wall.split(" ");
  if (!datePart || !timePart) return null;
  return `${datePart}T${timePart}+05:30`;
}

/**
 * Weekday name in English for the **India calendar day** of this instant (Asia/Kolkata).
 * @param {Date} d
 * @returns {string|null} e.g. "Sunday", "Monday"
 */
function getISTWeekdayLong(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

function isSundayIST(d) {
  return getISTWeekdayLong(d) === "Sunday";
}

module.exports = {
  parseAppointmentDateTimeAsIST,
  formatInstantAsISTIso,
  getISTWeekdayLong,
  isSundayIST,
};
