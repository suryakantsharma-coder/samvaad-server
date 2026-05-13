const {
  istTodayYmd,
  istTomorrowYmd,
  istDayAfterTomorrowYmd,
} = require("../src/utils/queryDateRange");
const { normalizeAppointmentDateTimeISOForBooking } = require("../src/utils/appointmentDateTimeIST");

/** Hindi / Devanagari spoken hours 1–12 */
const HI_HOUR_WORDS = {
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
  ग्यारह: 11,
  बारह: 12,
};

/** Gujarati spoken hours 1–12 */
const GU_HOUR_WORDS = {
  એક: 1,
  બે: 2,
  ત્રણ: 3,
  ચાર: 4,
  પાંચ: 5,
  છ: 6,
  સાત: 7,
  આઠ: 8,
  નવ: 9,
  દસ: 10,
  અગિયાર: 11,
  બાર: 12,
};

/**
 * @param {string} t
 * @returns {number|null}
 */
function parseHourFromText(t) {
  const s = String(t || "");
  const digit = s.match(/(\d{1,2})\s*(?:बजे|वजे|વાગ્યે|:|\b)/);
  if (digit) {
    const h = Number.parseInt(digit[1], 10);
    if (h >= 0 && h <= 23) return h;
  }
  for (const [w, n] of Object.entries(HI_HOUR_WORDS)) {
    if (s.includes(w)) return n;
  }
  for (const [w, n] of Object.entries(GU_HOUR_WORDS)) {
    if (s.includes(w)) return n;
  }
  return null;
}

/**
 * Adjust 1–12 clock to 24h using दोपहर/शाम etc.
 * @param {string} t
 * @param {number} h12
 * @returns {number}
 */
function to24h(t, h12) {
  let h = h12;
  if (h < 1 || h > 23) return h;
  const afternoon = /दोपहर|दुपहर|બપોર|બપોરે|afternoon/i.test(t);
  const evening = /शाम|shaam|સાંજ|evening/i.test(t);
  if (afternoon && h >= 1 && h <= 7) return h + 12;
  if (evening && h >= 1 && h <= 11) return h + 12;
  return h;
}

/**
 * @param {string} t
 * @returns {string|null} YYYY-MM-DD in IST calendar
 */
function resolveRelativeDateYmd(t) {
  const s = String(t || "");
  if (/(?:परसों|परसो|પરમ\s*દિવસે)/i.test(s)) return istDayAfterTomorrowYmd();
  if (/(?:^|[\s,।])कल(?:\s|$|[,।])|कल\s+सुबह|આવતી\s*કાલ|કાલે/i.test(s))
    return istTomorrowYmd();
  if (/आज|આજે|today/i.test(s)) return istTodayYmd();
  return null;
}

/**
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureNameFromTranscript(slots, text) {
  if (!slots || slots.fullName) return;
  const t = String(text || "").trim();
  if (t.length < 3) return;
  let m = t.match(
    /(?:मेरा\s+)?नाम\s+([^।.\n,]+?)(?:\s+है|\s+हूँ|\s+हूं|$)/u,
  );
  if (m && m[1]) {
    slots.fullName = m[1].replace(/\s+/g, " ").trim();
    return;
  }
  m = t.match(/my\s+name\s+is\s+(.+?)(?:\.|,|$)/i);
  if (m && m[1]) {
    slots.fullName = m[1].replace(/\s+/g, " ").trim();
  }
}

/**
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureAgeGenderFromTranscript(slots, text) {
  if (!slots) return;
  const t = String(text || "").trim();
  if (slots.age == null) {
    const ageM =
      t.match(/(?:उम्र|umr|उम्|ઉંમર|age)[^\d]{0,14}(\d{1,3})/i) ||
      t.match(/(\d{1,3})\s*(?:साल|वर्ष|વર્ષ|year)/i);
    if (ageM) {
      const a = Number.parseInt(ageM[1], 10);
      if (Number.isFinite(a) && a > 0 && a < 130) slots.age = a;
    }
  }
  if (!slots.gender) {
    if (/\bmale\b|मेल|मेन|पुरुष|પુરુષ/i.test(t)) slots.gender = "Male";
    else if (/\bfemale\b|फीमेल|महिला|स्त्री|સ્ત્રી/i.test(t))
      slots.gender = "Female";
    else if (/\bother\b|अन्य|અન્ય/i.test(t)) slots.gender = "Other";
  }
}

/**
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureFirstVisitFromTranscript(slots, text) {
  if (!slots || slots.firstVisit !== undefined) return;
  const t = String(text || "").trim();
  if (/पहली\s+बार|પહેલી\s*વખત|first\s*time|first\s*visit/i.test(t)) {
    slots.firstVisit = true;
    return;
  }
  if (
    /पहले\s+भी|पहले\s+आया|पहले\s+आई|visited\s*before|returning/i.test(t)
  ) {
    slots.firstVisit = false;
  }
}

/**
 * Remember आज/कल/परसों when the caller says the day without a clock time yet.
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} text
 */
function maybeCapturePendingDateYmd(slots, text) {
  if (!slots) return;
  const ymd = resolveRelativeDateYmd(String(text || ""));
  if (ymd) slots.pendingDateYmd = ymd;
}

/**
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureAppointmentIsoFromTranscript(slots, text) {
  if (!slots) return;
  const t = String(text || "").trim();
  if (t.length < 2) return;
  const ymd = resolveRelativeDateYmd(t) || slots.pendingDateYmd;
  if (!ymd) return;
  let hour = parseHourFromText(t);
  if (hour == null) return;
  if (hour <= 12) hour = to24h(t, hour);
  if (hour < 0 || hour > 23) return;
  const iso = `${ymd}T${String(hour).padStart(2, "0")}:00:00`;
  slots.appointmentDateTimeISO = normalizeAppointmentDateTimeISOForBooking(
    iso,
  ).iso;
}

/**
 * Apply all lightweight STT heuristics (idempotent / last value wins for same field).
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 * @param {string} rawUserText
 */
function applyTranscriptToBookingSlots(slots, rawUserText) {
  if (!slots) return;
  const raw = String(rawUserText || "").trim();
  if (!raw) return;
  maybeCaptureNameFromTranscript(slots, raw);
  maybeCaptureAgeGenderFromTranscript(slots, raw);
  maybeCaptureFirstVisitFromTranscript(slots, raw);
  maybeCapturePendingDateYmd(slots, raw);
  maybeCaptureAppointmentIsoFromTranscript(slots, raw);
}

module.exports = {
  applyTranscriptToBookingSlots,
  maybeCaptureNameFromTranscript,
  maybeCaptureAgeGenderFromTranscript,
  maybeCaptureFirstVisitFromTranscript,
  maybeCaptureAppointmentIsoFromTranscript,
};
