/**
 * IST booking rules for the voice agent.
 *
 * Order of checks (must match the agent's conversational flow):
 *   1. Day: no Sunday, no past times on "today".
 *   2. Doctor availability that day: handled by the holiday/leave check
 *      and the doctor.availability time-window check in the tool handler
 *      (`realtimeToolHandlers.create_appointment`).
 *   3. Capacity: each clock hour is one "slot" with capacity
 *      `floor(60 / AVG_PATIENT_CHECKUP_DURATION)` (env, default 10 → 6/hour).
 *      The requested datetime keeps its exact minute; we only reject when the
 *      hour bucket is already full and suggest the next free hour bucket
 *      within the doctor's availability ranges that same day.
 */
const mongoose = require("mongoose");
const AppointmentModel = require("../models/appointment.model");
const {
  formatCalendarDateIST,
  parseCalendarDayStartUtc,
  parseCalendarDayEndUtc,
} = require("./queryDateRange");
const { parseAppointmentDateTimeAsIST } = require("./appointmentDateTimeIST");
const {
  parseDoctorAvailabilityWindow,
  isTimeWithinDoctorAvailability,
} = require("../../whatsapp-chat-agent/utils/doctorAvailability");

const IST = "Asia/Kolkata";
const HOUR_MINUTES = 60;
const DEFAULT_AVG_CHECKUP_DURATION_MIN = 10;

/**
 * @returns {number} per-patient checkup duration in minutes (>=1).
 *   Reads AVG_PATIENT_CHECKUP_DURATION; falls back to 10.
 */
function getAvgCheckupDurationMin() {
  const raw = Number(process.env.AVG_PATIENT_CHECKUP_DURATION);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AVG_CHECKUP_DURATION_MIN;
  }
  return Math.max(1, Math.floor(raw));
}

/**
 * @returns {number} how many patients fit in one clock-hour bucket.
 *   60 / duration, clamped to >= 1.
 */
function getHourBucketCapacity() {
  return Math.max(1, Math.floor(HOUR_MINUTES / getAvgCheckupDurationMin()));
}

function getHourMinuteIST(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) =>
    parseInt(parts.find((x) => x.type === type)?.value || "0", 10);
  return { h: get("hour"), min: get("minute") };
}

/** Hour-of-day in IST (0–23) → minutes from midnight (0, 60, 120, …). */
function hourBucketStartMinIST(date) {
  const { h } = getHourMinuteIST(date);
  return h * HOUR_MINUTES;
}

/**
 * Snap a Date to the start of its IST hour bucket (HH:00).
 * Used at storage time so 10:30, 10:45, 10:59 all sit at 10:00 in the DB
 * and the "10–11 slot" semantics are reflected one-to-one in the data.
 * @param {Date} dt
 * @returns {Date}
 */
function snapToHourBucketStartIST(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return dt;
  const ymd = formatCalendarDateIST(dt);
  return istDateFromYmdAndMinutes(ymd, hourBucketStartMinIST(dt));
}

/**
 * Format an IST hour-bucket as a caller-friendly range label in three languages.
 * Use the bucket START time (HH:00). Output covers HH:00 → (HH+1):00.
 * @param {Date} dt
 * @returns {{ hindi: string, gujarati: string, english: string }}
 */
function formatHourSlotLabelForVoice(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) {
    return { hindi: "", gujarati: "", english: "" };
  }
  const start = snapToHourBucketStartIST(dt);
  const endMs = start.getTime() + HOUR_MINUTES * 60 * 1000;
  const end = new Date(endMs);
  const dayOpts = {
    timeZone: IST,
    weekday: "long",
    day: "numeric",
    month: "long",
  };
  const hourOpts = {
    timeZone: IST,
    hour: "numeric",
    hour12: true,
  };
  const fmtDay = (loc) => new Intl.DateTimeFormat(loc, dayOpts).format(start);
  const fmtHour = (loc, d) =>
    new Intl.DateTimeFormat(loc, hourOpts).format(d).replace(/\s+/g, " ").trim();
  const startHi = fmtHour("hi-IN", start);
  const endHi = fmtHour("hi-IN", end);
  const startGu = fmtHour("gu-IN", start);
  const endGu = fmtHour("gu-IN", end);
  const startEn = fmtHour("en-IN", start);
  const endEn = fmtHour("en-IN", end);
  return {
    hindi: `${fmtDay("hi-IN")}, ${startHi} से ${endHi} के बीच के स्लॉट`,
    gujarati: `${fmtDay("gu-IN")}, ${startGu} થી ${endGu} વચ્ચેનો સ્લોટ`,
    english: `${fmtDay("en-IN")}, ${startEn}–${endEn} slot`,
  };
}

/**
 * @param {Date} date
 * @returns {boolean} true if this instant falls on a Sunday in Asia/Kolkata.
 */
function isSundayIST(date) {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short",
  }).format(date);
  return short === "Sun";
}

/**
 * @param {Date} date
 * @param {Date} now
 */
function isPastTodayIST(date, now = new Date()) {
  const dKey = formatCalendarDateIST(date);
  const tKey = formatCalendarDateIST(now);
  if (dKey !== tKey) return false;
  return date.getTime() < now.getTime();
}

/**
 * @param {string} ymd YYYY-MM-DD (IST day of `date`)
 * @param {number} totalMin minutes from midnight (0–1439)
 */
function istDateFromYmdAndMinutes(ymd, totalMin) {
  const clamped = Math.min(Math.max(0, totalMin), 23 * 60 + 59);
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(min).padStart(2, "0");
  return parseAppointmentDateTimeAsIST(`${ymd}T${hh}:${mm}:00+05:30`);
}

/**
 * Strict hour-bucket-in-availability check.
 * The 11:00–12:00 bucket is "in availability 10–13" because 11:00 ≥ 10:00
 * and 11:00 < 13:00. The 13:00–14:00 bucket is NOT in 10–13 (start at the
 * boundary is treated as outside the bucket) and not in 14–19 either.
 */
function isHourBucketWithinAvailability(bucketStartMin, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return true;
  for (const { startMin, endMin } of ranges) {
    if (startMin <= endMin) {
      if (bucketStartMin >= startMin && bucketStartMin < endMin) return true;
    } else if (bucketStartMin >= startMin || bucketStartMin < endMin) {
      return true;
    }
  }
  return false;
}

/**
 * Per-hour-bucket counts of existing appointments for a doctor on one IST day.
 * @returns {Promise<Map<number, number>>} key = bucketStartMin (0, 60, …), value = count.
 */
async function loadHourBucketCounts(
  hospitalObjectId,
  doctorObjectId,
  ymd,
  excludeAppointmentId,
) {
  const start = parseCalendarDayStartUtc(ymd);
  const end = parseCalendarDayEndUtc(ymd);
  const counts = new Map();
  if (!start || !end) return counts;

  const q = {
    hospital: hospitalObjectId,
    doctor: doctorObjectId,
    appointmentDateTime: { $gte: start, $lte: end },
    status: { $ne: "Cancelled" },
  };
  if (excludeAppointmentId && mongoose.isValidObjectId(excludeAppointmentId)) {
    q._id = { $ne: excludeAppointmentId };
  }

  const docs = await AppointmentModel.find(q)
    .select("appointmentDateTime")
    .lean();

  for (const row of docs) {
    const t = row.appointmentDateTime;
    if (!t) continue;
    const d = t instanceof Date ? t : new Date(t);
    if (Number.isNaN(d.getTime())) continue;
    const bucket = hourBucketStartMinIST(d);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return counts;
}

/**
 * Next free hour bucket on the same IST day at or after `startBucketMin`,
 * inside the doctor's availability ranges and with capacity remaining.
 * @returns {Date|null} a Date at the bucket start (HH:00).
 */
function findNextFreeHourBucketSameDay(
  ymd,
  startBucketMin,
  counts,
  capacity,
  availabilityText,
  now,
) {
  const win = parseDoctorAvailabilityWindow(availabilityText);
  const todayYmd = formatCalendarDateIST(now);

  for (
    let bucket = startBucketMin;
    bucket < 24 * HOUR_MINUTES;
    bucket += HOUR_MINUTES
  ) {
    if (!isHourBucketWithinAvailability(bucket, win.ranges)) continue;
    const count = counts.get(bucket) || 0;
    if (count >= capacity) continue;
    const cand = istDateFromYmdAndMinutes(ymd, bucket);
    if (Number.isNaN(cand.getTime())) continue;
    if (ymd === todayYmd && cand.getTime() < now.getTime()) continue;
    return cand;
  }
  return null;
}

/**
 * @returns {null | { code: string, messages: { en: string, hi: string, gu: string, enVoice: string } }}
 */
function rejectIfSundayOrPast(dt, now = new Date()) {
  if (Number.isNaN(dt.getTime())) return null;
  if (isSundayIST(dt)) {
    return {
      code: "NO_SUNDAY_BOOKING",
      messages: {
        en: "We do not schedule appointments on Sunday. Pick Monday–Saturday.",
        hi: "रविवार को अपॉइंटमेंट नहीं लगते। कृपया सोमवार से शनिवार तक कोई दिन बताइए।",
        gu: "રવિવારે એપોઇન્ટમેન્ટ લેવાતી નથી. સોમવારથી શનિવાર સુધીનો દિવસ પસંદ કરશો?",
        enVoice:
          "We don't book appointments on Sundays. Please choose a weekday from Monday to Saturday.",
      },
    };
  }
  if (isPastTodayIST(dt, now)) {
    return {
      code: "NO_PAST_TIME_TODAY",
      messages: {
        en: "That time has already passed today. Pick a later time today or another day.",
        hi: "आज का वह समय निकल चुका है। आज के लिए बाद का समय या कोई और दिन बताइए।",
        gu: "આજે આ સમય નીકળી ગયો છે. આજ માટે પછીનો સમય કે બીજો દિવસ પસંદ કરશો?",
        enVoice:
          "That time has already gone for today. Please suggest a later time today, or another date.",
      },
    };
  }
  return null;
}

/**
 * Full policy + capacity check for create/update appointment.
 * @param {{
 *   hospitalObjectId: string,
 *   doctorObjectId: string,
 *   doctor: { availability?: string|null },
 *   dt: Date,
 *   excludeAppointmentMongoId?: string|null,
 * }} p
 * @returns {Promise<null | { code: string, messages: { en: string, hi: string, gu: string, enVoice: string } }>}
 */
async function validateBookingPoliciesAndSlot(p) {
  const {
    hospitalObjectId,
    doctorObjectId,
    doctor,
    dt,
    excludeAppointmentMongoId,
  } = p;

  if (Number.isNaN(dt.getTime())) {
    return null;
  }

  const early = rejectIfSundayOrPast(dt);
  if (early) {
    return early;
  }

  const now = new Date();
  const ymd = formatCalendarDateIST(dt);
  const requestedBucket = hourBucketStartMinIST(dt);
  const capacity = getHourBucketCapacity();

  const counts = await loadHourBucketCounts(
    hospitalObjectId,
    doctorObjectId,
    ymd,
    excludeAppointmentMongoId,
  );
  const used = counts.get(requestedBucket) || 0;

  if (used >= capacity) {
    const alt = findNextFreeHourBucketSameDay(
      ymd,
      requestedBucket + HOUR_MINUTES,
      counts,
      capacity,
      doctor.availability,
      now,
    );
    const requestedLabel = formatHourSlotLabelForVoice(
      istDateFromYmdAndMinutes(ymd, requestedBucket),
    );
    const altLabel = alt
      ? formatHourSlotLabelForVoice(alt)
      : { hindi: "", gujarati: "", english: "" };

    return {
      code: "HOUR_BUCKET_FULL",
      messages: {
        en: alt
          ? `The ${requestedLabel.english} is already full with ${capacity} bookings. Next available is the ${altLabel.english} — confirm with the caller.`
          : `The ${requestedLabel.english} is already full with ${capacity} bookings and no later one-hour slot is open today inside the doctor's hours.`,
        hi: alt
          ? `${requestedLabel.hindi} में पहले से ${capacity} मरीज़ बुक हैं। अगला खाली स्लॉट ${altLabel.hindi} है — क्या यह चलेगा?`
          : `${requestedLabel.hindi} में पहले से ${capacity} मरीज़ बुक हैं और आज डॉक्टर के समय में आगे कोई स्लॉट खाली नहीं है। कृपया कोई और दिन बताइए।`,
        gu: alt
          ? `${requestedLabel.gujarati} માં પહેલેથી ${capacity} દર્દી બુક છે. આગળનો ખાલી સ્લોટ ${altLabel.gujarati} છે — શું ચાલશે?`
          : `${requestedLabel.gujarati} માં પહેલેથી ${capacity} દર્દી બુક છે અને આજે ડૉક્ટરના સમયમાં બીજો ખાલી સ્લોટ નથી. બીજો દિવસ જણાવશો?`,
        enVoice: alt
          ? `The ${requestedLabel.english} is already full with ${capacity} patients. The next available one-hour slot is the ${altLabel.english}. Would that work for you?`
          : `The ${requestedLabel.english} is already full, and I don't have another open one-hour slot later today inside the doctor's hours. Please choose another date.`,
      },
    };
  }

  return null;
}

module.exports = {
  HOUR_MINUTES,
  getAvgCheckupDurationMin,
  getHourBucketCapacity,
  hourBucketStartMinIST,
  snapToHourBucketStartIST,
  formatHourSlotLabelForVoice,
  isSundayIST,
  isPastTodayIST,
  isHourBucketWithinAvailability,
  rejectIfSundayOrPast,
  validateBookingPoliciesAndSlot,
  loadHourBucketCounts,
  findNextFreeHourBucketSameDay,
};
