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
 * Normalize LLM/tool datetime strings to IST wall-clock ISO before booking.
 * @param {string} raw
 * @returns {{ iso: string, hadZSuffix: boolean }}
 */
function normalizeAppointmentDateTimeISOForBooking(raw) {
  const s = String(raw || "").trim();
  if (!s) return { iso: "", hadZSuffix: false };

  const hadZSuffix = /Z$/i.test(s);
  if (/[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    return { iso: s, hadZSuffix };
  }

  const withoutZ = s.replace(/Z$/i, "");
  const withTime = withoutZ.includes("T") ? withoutZ : `${withoutZ}T00:00:00`;
  return { iso: `${withTime}+05:30`, hadZSuffix };
}

module.exports = {
  parseAppointmentDateTimeAsIST,
  formatInstantAsISTIso,
  normalizeAppointmentDateTimeISOForBooking,
};
