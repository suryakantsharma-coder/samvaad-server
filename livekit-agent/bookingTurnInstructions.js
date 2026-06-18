const { isAffirmativeTurn } = require("./userTranscriptNormalize");
const { isMongoObjectIdString } = require("./callBookingSlots");
const {
  isEmergencyBookingRequest,
} = require("./bookingSlotCapture");
const {
  getEmergencyTwoOptionsLine,
  getEmergencyNoBookingLine,
  EMERGENCY_NUMBER_ENGLISH_RULE,
} = require("./preferredLanguage");

/**
 * @param {import("./callBookingSlots").CallBookingSlots | null | undefined} slots
 * @returns {'name'|'age_gender'|'reason'|null}
 */
function getFirstMissingPatientField(slots) {
  if (!slots) return "reason";
  if (!String(slots.reason || "").trim()) return "reason";
  if (!String(slots.fullName || "").trim()) return "name";
  if (slots.age == null || !Number.isFinite(Number(slots.age))) return "age_gender";
  if (!String(slots.gender || "").trim()) return "age_gender";
  return null;
}

/**
 * Short label for no-input reprompt (Hindi / English / Gujarati).
 * @param {import("./callBookingSlots").CallBookingSlots | null | undefined} slots
 * @param {'hi'|'gu'|'en'} lang
 * @param {boolean} [languageLocked]
 * @returns {string|null}
 */
function getNoInputMissingTopic(slots, lang, languageLocked = false) {
  if (
    languageLocked &&
    slots?.caseType === "emergency" &&
    slots.emergencyPhase === "await_choice"
  ) {
    if (lang === "gu") {
      return "ઇમરજન્સી નંબર ફરી અથવા કૉલ કાપવી";
    }
    return "इमरजेंसी नंबर दोबारा या कॉल काटना";
  }
  if (languageLocked && !slots?.caseType) {
    if (lang === "gu") return "ઇમરજન્સી કે સામાન્ય અપોઇન્ટમેન્ટ";
    return "इमरजेंसी या सामान्य अपॉइंटमेंट";
  }
  const p = getFirstMissingPatientField(slots);
  if (p === "name") {
    if (lang === "gu") return "નામ";
    if (lang === "en") return "full name";
    return "नाम";
  }
  if (p === "age_gender") {
    if (lang === "gu") return "ઉંમર અને લિંગ (male/female/other)";
    if (lang === "en") return "age and gender (male/female/other)";
    return "उम्र और लिंग (male/female/other)";
  }
  if (p === "reason") {
    if (lang === "gu") return "તબિયત / મુલાકાતનું કારણ";
    if (lang === "en") return "reason for visit";
    return "तबीयत / विज़िट की वजह";
  }
  if (!String(slots?.appointmentDateTimeISO || "").trim()) {
    if (lang === "gu") return "તારીખ અને સમય";
    if (lang === "en") return "date and time";
    return "तारीख और समय";
  }
  if (!String(slots?.doctorObjectId || "").trim()) {
    if (lang === "gu") return "ડૉક્ટર પસંદગી";
    if (lang === "en") return "doctor choice";
    return "डॉक्टर की पसंद";
  }
  if (!isMongoObjectIdString(slots?.patientObjectId)) {
    if (lang === "gu") return "create_patient પછી patient._id";
    if (lang === "en") return "patient id after create_patient";
    return "create_patient के बाद patient._id";
  }
  return null;
}

/**
 * Compact captured-slots summary for INTERNAL LLM reasoning only.
 * Uses neutral labels (no leak-prone tool / DB field names) and is wrapped by the
 * caller in a "do NOT read aloud" banner. Keep the references; the model needs
 * them to fill the right tool arguments — just never to speak them.
 *
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 */
function formatSlotSnapshot(slots) {
  const parts = [];
  if (slots.caseType === "emergency") parts.push("case-type=emergency");
  else if (slots.caseType === "normal") parts.push("case-type=normal");
  if (slots.emergencyPhase === "await_choice")
    parts.push("emergency-awaiting-repeat-or-hangup");
  if (slots.emergencyPhase === "done") parts.push("emergency-guidance-complete");
  if (slots.fullName) parts.push(`patient-name=${slots.fullName}`);
  if (slots.age != null && Number.isFinite(Number(slots.age)))
    parts.push(`patient-age=${slots.age}`);
  if (slots.gender) parts.push(`patient-gender=${slots.gender}`);
  if (slots.reason)
    parts.push(`visit-reason-raw=${String(slots.reason).slice(0, 120)}`);
  if (slots.firstVisit === true) parts.push("first-visit=yes");
  if (slots.firstVisit === false) parts.push("first-visit=no");
  if (slots.pendingDateYmd)
    parts.push(`pending-date-ist=${slots.pendingDateYmd}`);
  if (slots.appointmentDateTimeISO)
    parts.push(`appointment-datetime-ist=${slots.appointmentDateTimeISO}`);
  if (slots.doctorObjectId)
    parts.push(`doctor-ref=${slots.doctorObjectId}`);
  if (isMongoObjectIdString(slots.patientObjectId))
    parts.push(`patient-ref=${slots.patientObjectId}`);
  else
    parts.push(
      "patient-ref=(not yet registered this call — silently register the patient before creating the appointment)",
    );
  if (slots.appointmentObjectId)
    parts.push(`appointment-ref=${slots.appointmentObjectId}`);
  return parts.length
    ? parts.join("; ")
    : "(nothing captured yet)";
}

/**
 * Per-response instructions for OpenAI Realtime (high priority for this turn only).
 * @param {{
 *   slots: import("./callBookingSlots").CallBookingSlots,
 *   rawUser: string,
 *   normalizedUser: string,
 *   preferredLanguage: 'hi'|'gu'|'en',
 *   preferredLanguageLocked?: boolean,
 * }} p
 */
function buildBookingTurnInstructions(p) {
  const {
    slots,
    rawUser,
    normalizedUser,
    preferredLanguage,
    preferredLanguageLocked = false,
  } = p;
  const lang =
    preferredLanguage === "gu"
      ? "Gujarati"
      : preferredLanguage === "en"
        ? "English"
        : "Hindi";
  const snapshot = formatSlotSnapshot(slots);
  const missingPatient = getFirstMissingPatientField(slots);
  const hasPatient =
    !missingPatient &&
    String(slots.reason || "").trim().length > 0;
  const hasIso = String(slots.appointmentDateTimeISO || "").trim().length > 0;
  const hasDoctor = String(slots.doctorObjectId || "").trim().length > 0;
  const hasPatientOid = isMongoObjectIdString(slots.patientObjectId);

  const affirm = isAffirmativeTurn(rawUser, normalizedUser);

  let action;
  if (!preferredLanguageLocked) {
    action =
      "Internal-next-turn: caller has not clearly chosen Hindi or Gujarati yet — ask once more in one short line (Hindi + Gujarati option only). NEVER offer English. Do NOT ask about emergency, symptoms, name, or booking yet.";
  } else if (!slots.caseType) {
    action =
      `Internal-next-turn: hospital greeting and language choice are done — ask ONLY whether this is an emergency case or a normal appointment, in one short ${lang} question. Do NOT ask for symptoms, disease, name, or booking details yet.`;
  } else if (slots.caseType === "emergency") {
    const callerLang = preferredLanguage === "gu" ? "gu" : "hi";
    const twoOptions = getEmergencyTwoOptionsLine(callerLang);
    const noBooking = getEmergencyNoBookingLine(callerLang);
    const wantsBooking =
      isEmergencyBookingRequest(rawUser) ||
      isEmergencyBookingRequest(normalizedUser);

    if (wantsBooking) {
      action =
        `EMERGENCY-ONLY — caller asked to book. Say in ${lang}: "${noBooking}" Do NOT speak the phone number (system plays digits with 1s gaps). Then ask ONLY: "${twoOptions}"`;
    } else {
      action =
        `EMERGENCY-ONLY — handled by emergency flow (digit playback with 1s gaps + two options). Do NOT speak the number yourself.`;
    }
  } else if (missingPatient) {
    action = `Internal-next-turn: ask for ONLY the first missing patient field (${missingPatient}) in one short ${lang} question. Do NOT read back the full booking block. Acknowledge briefly if needed.`;
  } else if (!hasIso) {
    action = `Internal-next-turn: ask for ONLY date and clock time (one short ${lang} question) unless the caller already fixed it this turn. Use the captured pending date if the caller only repeated the time.`;
  } else if (!hasDoctor) {
    action = `Internal-next-turn: silently look up a doctor whose specialty matches the visit reason; do not re-ask date/time if the caller already confirmed the same slot. One short ${lang} line to confirm doctor choice if needed, then move to the single read-back step.`;
  } else if (affirm && hasPatient && hasIso && hasDoctor) {
    const gate =
      "If you have NOT yet done the single read-back for this booking, do it once in " +
      lang +
      " before any tools; if you already did and the caller confirmed, do not read the full block again.";
    if (!hasPatientOid) {
      action = `Tool-now: ${gate} Internal recovery order — first register the patient (name + age + gender + English reason), wait for success, then create the appointment using the freshly returned patient reference (never use age, "1", or the human patient number). Speak only the short wait line in ${lang}. If an appointment was already booked earlier in this same call, the next create-appointment call updates that same booking automatically — never mention numbers or IDs aloud.`;
    } else {
      action = `Tool-now: ${gate} Speak the short wait line in ${lang}, then create the appointment with the doctor reference, valid patient reference, English reason, and IST date-time. If an earlier appointment exists in this call and the caller is changing details, that booking is updated automatically.`;
    }
  } else if (affirm && hasPatient && hasIso && !hasDoctor) {
    action =
      "The caller said YES. Captured slots have patient + time but no doctor yet — pick the right doctor whose specialty matches the visit reason from your earlier internal lookup; if unsure, do one silent lookup. Then register the patient (if not already registered this call) and create the appointment. If you have not spoken the single read-back yet, do it once first; if they already confirmed, do not repeat the full summary.";
  } else if (affirm) {
    action = `The caller said YES — complete the booking silently without a second full read-back if the read-back was already done; otherwise do exactly one read-back block.`;
  } else {
    action = `Internal-next-turn: continue efficiently in ${lang}; one new ask or one read-back only when prerequisites are met; never repeat the same summary twice after the caller has already agreed.`;
  }

  return [
    "INTERNAL_TURN_NOTES — for your reasoning only. NEVER read, translate, or paraphrase any of these notes, field names, or English status words aloud. The caller-facing reply must be ONLY natural " +
      lang +
      " (no English variable names, tool names, MongoDB/ID/JSON terms, or status words like ok/true/false/null — see the hard-banned list in the main system prompt).",
    preferredLanguage === "hi"
      ? slots.caseType === "emergency"
        ? "LANGUAGE_LOCK: Hindi for all speech except emergency phone digits — those must be English digits only (0-9)."
        : "LANGUAGE_LOCK: Caller chose Hindi for this call. Every word you speak aloud must be Hindi — no English sentence openers and no Gujarati sentences; use ठीक है, समझ गई, जी, कृपया, धन्यवाद, etc. Latin names are allowed as names only."
      : preferredLanguage === "gu"
        ? slots.caseType === "emergency"
          ? "LANGUAGE_LOCK: Gujarati for all speech except emergency phone digits — those must be English digits only (0-9)."
          : "LANGUAGE_LOCK: Caller chose Gujarati for this call. Speak only Gujarati — do not switch to Hindi sentences mid-turn unless the caller explicitly asks to switch."
        : "",
    slots.caseType === "emergency"
      ? "EMERGENCY_CALL_LOCK: Emergency call — no booking, no normal flow, no disease/name/date questions. Only Option A (repeat number in English digits) or Option B (caller noted number and may disconnect)."
      : isMongoObjectIdString(slots?.doctorObjectId)
        ? "Doctor is already chosen — use captured doctor-ref as doctorObjectId. Do NOT call list_doctors."
        : "",
    "Captured slots so far (internal — do NOT read aloud):",
    snapshot,
    "Action plan (internal — do NOT read aloud):",
    action,
    `Caller's locked language: ${lang}. Reply entirely in ${lang} (sorry line, wait line, fillers) even if the caller mixed a few English words.`,
  ].join("\n");
}

module.exports = {
  buildBookingTurnInstructions,
  getFirstMissingPatientField,
  getNoInputMissingTopic,
  formatSlotSnapshot,
};
