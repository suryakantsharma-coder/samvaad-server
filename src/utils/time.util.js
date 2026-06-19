/**
 * Helpers for medicine reminder scheduling (local server time;
 * set TZ or REMINDER_TIMEZONE at process level for production if needed).
 */

const env = require('../config/env');

const SLOTS = ['breakfast', 'lunch', 'dinner'];

/** Local wall-clock times for each slot (production, Asia/Kolkata via process TZ). */
const SLOT_HOURS = {
  breakfast: { hour: 9, minute: 0, second: 0, ms: 0 },
  lunch: { hour: 14, minute: 0, second: 0, ms: 0 },
  dinner: { hour: 20, minute: 0, second: 0, ms: 0 },
};

/**
 * Test mode: each logical "day" lasts TEST_DAY_SPACING_MS; slots fall in the first ~50 minutes of that window.
 */
const TEST_DAY_SPACING_MS = 60 * 60 * 1000;
const TEST_SLOT_MINUTES_FROM_DAY_START = {
  breakfast: 2,
  lunch: 25,
  dinner: 48,
};

function isReminderTestMode() {
  const v = String(env.REMINDER_TEST_MODE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

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
 * Scheduled datetime for a meal slot.
 *
 * **Production:** calendar day from `anchorDate` + wall-clock slot time.
 *
 * **Test mode (`REMINDER_TEST_MODE`):** `scheduleReferenceTime` (usually “now” when the prescription
 * was saved) + `dayOffset` × 1h + slot offset (2 / 25 / 48 min) — all three meals within ~one hour per day.
 *
 * @param {Date} anchorDate
 * @param {number} dayOffset
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @param {Date} [scheduleReferenceTime] - required for test mode (pass same `now` as scheduling)
 * @returns {Date}
 */
function getScheduledDateTimeForSlot(anchorDate, dayOffset, slot, scheduleReferenceTime) {
  if (isReminderTestMode() && scheduleReferenceTime instanceof Date && !Number.isNaN(scheduleReferenceTime.getTime())) {
    const mins = TEST_SLOT_MINUTES_FROM_DAY_START[slot];
    if (mins === undefined) {
      throw new Error(`Invalid slot: ${slot}`);
    }
    const dayStartMs = scheduleReferenceTime.getTime() + dayOffset * TEST_DAY_SPACING_MS;
    return new Date(dayStartMs + mins * 60 * 1000);
  }

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
 * Latest scheduled medicine reminder instant for a prescription course.
 * @param {Date} anchorDate
 * @param {number} followUpDays
 * @param {object[]} medicines
 * @param {Date} [scheduleReferenceTime]
 * @returns {Date|null}
 */
function getLastMedicineDoseScheduledAt(anchorDate, followUpDays, medicines, scheduleReferenceTime) {
  const list = Array.isArray(medicines) ? medicines : [];
  const days = Math.max(0, Number(followUpDays) || 0);
  if (!days || !list.length) return null;

  let last = null;
  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    for (const slot of SLOTS) {
      const hasActive = list.some((m) => {
        const t = m?.time;
        if (!t || typeof t !== "object" || !t[slot]) return false;
        const durationDays =
          m.duration != null && typeof m.duration === "object" && typeof m.duration.value === "number"
            ? Math.floor(m.duration.value)
            : typeof m.duration === "string" && m.duration.match(/(\d+)/)
              ? Math.max(1, parseInt(m.duration.match(/(\d+)/)[1], 10))
              : null;
        if (durationDays != null && dayOffset >= durationDays) return false;
        return true;
      });
      if (!hasActive) continue;

      const at = getScheduledDateTimeForSlot(anchorDate, dayOffset, slot, scheduleReferenceTime);
      if (!last || at.getTime() > last.getTime()) {
        last = at;
      }
    }
  }
  return last;
}

/**
 * Absolute time for dosage-completion feedback job.
 * **Production:** 12 hours after the last scheduled medicine dose.
 * **Test mode:** 12 minutes after the last dinner of the last scheduled day.
 *
 * @param {Date} anchorDate
 * @param {number} followUpDays - `followUp.value`
 * @param {{ hour?: number, minute?: number, delayHours?: number }} [opts]
 * @param {Date} [scheduleReferenceTime]
 * @param {object[]} [medicines]
 * @returns {Date}
 */
function getFeedbackScheduledAt(
  anchorDate,
  followUpDays,
  opts = {},
  scheduleReferenceTime = null,
  medicines = [],
) {
  if (
    isReminderTestMode() &&
    scheduleReferenceTime instanceof Date &&
    !Number.isNaN(scheduleReferenceTime.getTime())
  ) {
    const lastDay = Math.max(0, followUpDays - 1);
    const lastDinnerMs =
      scheduleReferenceTime.getTime() +
      lastDay * TEST_DAY_SPACING_MS +
      TEST_SLOT_MINUTES_FROM_DAY_START.dinner * 60 * 1000;
    return new Date(lastDinnerMs + 12 * 60 * 1000);
  }

  const delayHours = opts.delayHours ?? 12;
  const lastDose = getLastMedicineDoseScheduledAt(
    anchorDate,
    followUpDays,
    medicines,
    scheduleReferenceTime,
  );
  if (lastDose) {
    return new Date(lastDose.getTime() + delayHours * 60 * 60 * 1000);
  }

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
  TEST_DAY_SPACING_MS,
  TEST_SLOT_MINUTES_FROM_DAY_START,
  isReminderTestMode,
  getStartOfLocalDay,
  getReminderAnchorDate,
  getScheduledDateTimeForSlot,
  computeDelayMs,
  getLastMedicineDoseScheduledAt,
  getFeedbackScheduledAt,
};
