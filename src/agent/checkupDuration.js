/**
 * Agent-only: per-doctor checkup duration and hour-slot capacity.
 * Uses doctor.averagePatientTime when set; otherwise AVG_PATIENT_CHECKUP_DURATION (default 10).
 */
const {
  rejectIfSundayOrPast,
  loadHourBucketCounts,
  findNextFreeHourBucketSameDay,
  formatHourSlotLabelForVoice,
  hourBucketStartMinIST,
  HOUR_MINUTES,
} = require("../utils/bookingSlotRules");
const { formatCalendarDateIST } = require("../utils/queryDateRange");
const { parseAppointmentDateTimeAsIST } = require("../utils/appointmentDateTimeIST");

function istDateFromYmdAndMinutes(ymd, totalMin) {
  const clamped = Math.min(Math.max(0, totalMin), 23 * 60 + 59);
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(min).padStart(2, "0");
  return parseAppointmentDateTimeAsIST(`${ymd}T${hh}:${mm}:00+05:30`);
}

const DEFAULT_AVG_CHECKUP_DURATION_MIN = 10;

function getEnvAvgCheckupDurationMin() {
  const raw = Number(process.env.AVG_PATIENT_CHECKUP_DURATION);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AVG_CHECKUP_DURATION_MIN;
  }
  return Math.max(1, Math.floor(raw));
}

/**
 * @param {object|null|undefined} doctor
 * @returns {number} whole minutes per patient (>= 1)
 */
function resolveAvgPatientTimeMinutes(doctor) {
  const fromDoctor = doctor?.averagePatientTime;
  if (
    Number.isFinite(fromDoctor) &&
    fromDoctor > 0 &&
    Number.isInteger(fromDoctor)
  ) {
    return fromDoctor;
  }
  return getEnvAvgCheckupDurationMin();
}

/**
 * @param {object|null|undefined} doctor
 * @returns {number} patients per clock-hour slot (>= 1)
 */
function resolveHourBucketCapacity(doctor) {
  return Math.max(
    1,
    Math.floor(HOUR_MINUTES / resolveAvgPatientTimeMinutes(doctor)),
  );
}

/**
 * Same as validateBookingPoliciesAndSlot but uses doctor-specific slot capacity.
 * @returns {Promise<null | { code: string, messages: object }>}
 */
async function validateDoctorBookingPoliciesAndSlot(p) {
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
  const capacity = resolveHourBucketCapacity(doctor);

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
  resolveAvgPatientTimeMinutes,
  resolveHourBucketCapacity,
  validateDoctorBookingPoliciesAndSlot,
};
