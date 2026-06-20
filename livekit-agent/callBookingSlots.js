/**
 * @typedef {{
 *   caseType?: 'emergency' | 'normal',
 *   reason?: string,
 *   fullName?: string,
 *   age?: number,
 *   gender?: string,
 *   firstVisit?: boolean,
 *   doctorObjectId?: string,
 *   patientObjectId?: string,
 *   appointmentObjectId?: string,
 *   appointmentDateTimeISO?: string,
 *   pendingDateYmd?: string,
 * }} CallBookingSlots
 */

const VISIT_REASON_HINT =
  /(?:दर्द|बीमार|समस्या|तकलीफ|symptom|pain|fever|cold|cough|ache|infection|bp|diabetes|piles|dard|દર્દ|સમસ્યા|બીમાર)/i;

const NON_REASON_HINT =
  /^(?:हाँ|हा|ना|नहीं|yes|no|haa?|ji|ok|theek|thik|male|female|मेल|कल|आज|tomorrow|today|\d+\s*(?:साल|वर्ष|year|मेल)?)/i;

const EMERGENCY_CASE_HINT =
  /(?:emergency|आपातकाल|आपात|तुरंत|urgent|एमर्जेंसी)/i;
const NORMAL_CASE_HINT =
  /(?:normal|सामान्य|routine|regular|नहीं\s*आपात|not\s+an?\s+emergency|नॉर्मल)/i;

/** 24 hex chars — Mongo ObjectId string form */
function isMongoObjectIdString(s) {
  return /^[a-fA-F0-9]{24}$/.test(String(s || "").trim());
}

/**
 * @returns {CallBookingSlots}
 */
function createCallBookingSlots() {
  return {};
}

/**
 * @param {CallBookingSlots} slots
 * @param {Record<string, unknown>} args
 */
function updateSlotsFromToolArgs(slots, args) {
  if (!slots || !args || typeof args !== "object") return;
  const reason = String(args.reason || "").trim();
  if (reason) slots.reason = reason;
  const fullName = String(args.fullName || "").trim();
  if (fullName) slots.fullName = fullName;
  const age = Number(args.age);
  if (Number.isFinite(age) && age >= 0) slots.age = age;
  const gender = String(args.gender || "").trim();
  if (gender) slots.gender = gender;
  const doctorObjectId = String(args.doctorObjectId || "").trim();
  if (doctorObjectId && isMongoObjectIdString(doctorObjectId)) {
    slots.doctorObjectId = doctorObjectId;
  }
  const patientObjectId = String(args.patientObjectId || "").trim();
  if (patientObjectId && isMongoObjectIdString(patientObjectId)) {
    slots.patientObjectId = patientObjectId;
  }
  const appointmentDateTimeISO = String(
    args.appointmentDateTimeISO || "",
  ).trim();
  if (appointmentDateTimeISO)
    slots.appointmentDateTimeISO = appointmentDateTimeISO;
}

/**
 * @param {CallBookingSlots} slots
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function mergeToolArgsWithSlots(slots, args) {
  const merged = { ...(args && typeof args === "object" ? args : {}) };
  if (!slots) return merged;
  if (!String(merged.reason || "").trim() && slots.reason) {
    merged.reason = slots.reason;
  }
  if (!String(merged.fullName || "").trim() && slots.fullName) {
    merged.fullName = slots.fullName;
  }
  if (
    (merged.age == null ||
      merged.age === "" ||
      Number.isNaN(Number(merged.age))) &&
    slots.age != null
  ) {
    merged.age = slots.age;
  }
  if (!String(merged.gender || "").trim() && slots.gender) {
    merged.gender = slots.gender;
  }
  if (!String(merged.doctorObjectId || "").trim() && slots.doctorObjectId) {
    merged.doctorObjectId = slots.doctorObjectId;
  }
  if (!String(merged.patientObjectId || "").trim() && slots.patientObjectId) {
    const pid = String(slots.patientObjectId).trim();
    if (isMongoObjectIdString(pid)) merged.patientObjectId = pid;
  }
  if (
    !String(merged.appointmentDateTimeISO || "").trim() &&
    slots.appointmentDateTimeISO
  ) {
    merged.appointmentDateTimeISO = slots.appointmentDateTimeISO;
  }
  if (!String(merged.type || "").trim() && slots.caseType === "emergency") {
    merged.type = "emergency";
  }
  /** Second+ create_appointment in the same call updates this row instead of creating another. */
  if (
    !String(merged.existingAppointmentObjectId || "").trim() &&
    slots.appointmentObjectId
  ) {
    merged.existingAppointmentObjectId = slots.appointmentObjectId;
  }
  return merged;
}

/**
 * Capture emergency vs normal case from caller STT (after language is locked).
 * @param {CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureCaseTypeFromTranscript(slots, text) {
  if (!slots || slots.caseType) return;
  const t = String(text || "").trim();
  if (!t || t.length < 3) return;
  if (
    /^(?:hindi|english|हिंदी|हिन्दी|इंग्लिश|अंग्रेजी|inglish|angrezi)\b/i.test(
      t,
    )
  ) {
    return;
  }
  if (EMERGENCY_CASE_HINT.test(t)) slots.caseType = "emergency";
  else if (NORMAL_CASE_HINT.test(t)) slots.caseType = "normal";
}

/**
 * Capture likely visit-reason phrases from caller STT (Hindi/Gujarati/English).
 * @param {CallBookingSlots} slots
 * @param {string} text
 */
function maybeCaptureVisitReasonFromTranscript(slots, text) {
  if (!slots) return;
  if (!slots.caseType) return;
  const t = String(text || "").trim();
  if (t.length < 6 || NON_REASON_HINT.test(t)) return;
  if (!VISIT_REASON_HINT.test(t)) return;
  if (!slots.reason) slots.reason = t;
}

module.exports = {
  createCallBookingSlots,
  updateSlotsFromToolArgs,
  mergeToolArgsWithSlots,
  maybeCaptureCaseTypeFromTranscript,
  maybeCaptureVisitReasonFromTranscript,
  isMongoObjectIdString,
};
