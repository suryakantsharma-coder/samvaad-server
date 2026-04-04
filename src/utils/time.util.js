/**
 * Helpers for medicine reminder scheduling (local server time;
 * set TZ or REMINDER_TIMEZONE at process level for production if needed).
 */

const SLOTS = ['breakfast', 'lunch', 'dinner'];

/** Local wall-clock times for each slot. */
const SLOT_HOURS = {
  breakfast: { hour: 9, minute: 0, second: 0, ms: 0 },
  lunch: { hour: 14, minute: 0, second: 0, ms: 0 },
  dinner: { hour: 23, minute: 40, second: 0, ms: 0 },
};

/**
 * Start of calendar day in local time for the given instant.
 * @param {Date} date
 * @returns {Date}
 */
function getStartOfLocalDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Anchor date for the reminder window: appointmentDate if valid, else fallback.
 * @param {{ appointmentDate?: Date|null, createdAt?: Date }} prescription
 * @returns {Date}
 */
function getReminderAnchorDate(prescription) {
  const appt = prescription.appointmentDate;
  if (appt instanceof Date && !Number.isNaN(appt.getTime())) {
    return appt;
  }
  const created = prescription.createdAt instanceof Date ? prescription.createdAt : new Date();
  return created;
}

/**
 * Scheduled local datetime for a given anchor day offset and meal slot.
 * @param {Date} anchorDate - any instant on the first calendar day of the regimen
 * @param {number} dayOffset - 0-based index within follow-up window
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @returns {Date}
 */
function getScheduledDateTimeForSlot(anchorDate, dayOffset, slot) {
  const start = getStartOfLocalDay(anchorDate);
  const t = new Date(start.getTime());
  t.setDate(t.getDate() + dayOffset);
  const parts = SLOT_HOURS[slot];
  if (!parts) {
    throw new Error(`Invalid slot: ${slot}`);
  }
  t.setHours(parts.hour, parts.minute, parts.second, parts.ms);
  return t;
}

/**
 * Milliseconds from now until target (clamped at 0 for BullMQ delay).
 * @param {Date} scheduledAt
 * @param {Date} [now=new Date()]
 * @returns {number}
 */
function computeDelayMs(scheduledAt, now = new Date()) {
  const ms = scheduledAt.getTime() - now.getTime();
  return ms > 0 ? ms : 0;
}

/**
 * Absolute time for feedback job: morning after (followUpDays + 1) calendar days from anchor.
 * @param {Date} anchorDate
 * @param {number} followUpDays - `followUp.value`
 * @param {{ hour?: number, minute?: number }} [opts]
 * @returns {Date}
 */
function getFeedbackScheduledAt(anchorDate, followUpDays, opts = {}) {
  const hour = opts.hour ?? 10;
  const minute = opts.minute ?? 0;
  const start = getStartOfLocalDay(anchorDate);
  const t = new Date(start.getTime());
  t.setDate(t.getDate() + followUpDays + 1);
  t.setHours(hour, minute, 0, 0);
  return t;
}

module.exports = {
  SLOTS,
  SLOT_HOURS,
  getStartOfLocalDay,
  getReminderAnchorDate,
  getScheduledDateTimeForSlot,
  computeDelayMs,
  getFeedbackScheduledAt,
};
