const { isAffirmativeTurn } = require("./userTranscriptNormalize");
const { isMongoObjectIdString } = require("./callBookingSlots");

/**
 * @param {import("./callBookingSlots").CallBookingSlots | null | undefined} slots
 * @returns {'name'|'age_gender'|'reason'|null}
 */
function getFirstMissingPatientField(slots) {
  if (!slots) return "name";
  if (!String(slots.fullName || "").trim()) return "name";
  if (slots.age == null || !Number.isFinite(Number(slots.age))) return "age_gender";
  if (!String(slots.gender || "").trim()) return "age_gender";
  if (!String(slots.reason || "").trim()) return "reason";
  return null;
}

/**
 * Short label for no-input reprompt (Hindi / Gujarati).
 * @param {import("./callBookingSlots").CallBookingSlots | null | undefined} slots
 * @param {'hi'|'gu'} lang
 * @returns {string|null}
 */
function getNoInputMissingTopic(slots, lang) {
  const p = getFirstMissingPatientField(slots);
  if (p === "name") return lang === "gu" ? "નામ" : "नाम";
  if (p === "age_gender")
    return lang === "gu" ? "ઉંમર અને લિંગ (male/female/other)" : "उम्र और लिंग (male/female/other)";
  if (p === "reason")
    return lang === "gu" ? "તબિયત / મુલાકાતનું કારણ" : "तबीयत / विज़िट की वजह";
  if (!String(slots?.appointmentDateTimeISO || "").trim()) {
    return lang === "gu" ? "તારીખ અને સમય" : "तारीख और समय";
  }
  if (!String(slots?.doctorObjectId || "").trim()) {
    return lang === "gu" ? "ડૉક્ટર પસંદગી" : "डॉक्टर की पसंद";
  }
  if (!isMongoObjectIdString(slots?.patientObjectId)) {
    return lang === "gu" ? "create_patient પછી patient._id" : "create_patient के बाद patient._id";
  }
  return null;
}

/**
 * @param {import("./callBookingSlots").CallBookingSlots} slots
 */
function formatSlotSnapshot(slots) {
  const parts = [];
  if (slots.fullName) parts.push(`fullName=${slots.fullName}`);
  if (slots.age != null && Number.isFinite(Number(slots.age)))
    parts.push(`age=${slots.age}`);
  if (slots.gender) parts.push(`gender=${slots.gender}`);
  if (slots.reason) parts.push(`reason(raw)=${String(slots.reason).slice(0, 120)}`);
  if (slots.firstVisit === true) parts.push("firstVisit=yes");
  if (slots.firstVisit === false) parts.push("firstVisit=no");
  if (slots.pendingDateYmd) parts.push(`pendingDateYmd=${slots.pendingDateYmd}`);
  if (slots.appointmentDateTimeISO)
    parts.push(`appointmentDateTimeISO=${slots.appointmentDateTimeISO}`);
  if (slots.doctorObjectId) parts.push(`doctorObjectId=${slots.doctorObjectId}`);
  if (isMongoObjectIdString(slots.patientObjectId))
    parts.push(`patientObjectId=${slots.patientObjectId}`);
  else parts.push("patientObjectId=(missing — run create_patient first, then use patient._id)");
  return parts.length ? parts.join("; ") : "(nothing captured yet from STT heuristics)";
}

/**
 * Per-response instructions for OpenAI Realtime (high priority for this turn only).
 * @param {{
 *   slots: import("./callBookingSlots").CallBookingSlots,
 *   rawUser: string,
 *   normalizedUser: string,
 *   preferredLanguage: 'hi'|'gu',
 * }} p
 */
function buildBookingTurnInstructions(p) {
  const { slots, rawUser, normalizedUser, preferredLanguage } = p;
  const lang = preferredLanguage === "gu" ? "Gujarati" : "Hindi";
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
  if (missingPatient) {
    action = `NEXT_TURN: Ask for ONLY the first missing patient field (${missingPatient}) in one short ${lang} question. Do NOT read back the full booking block. Acknowledge briefly if needed.`;
  } else if (!hasIso) {
    action = `NEXT_TURN: Ask for ONLY date and clock time (one short ${lang} question) unless the caller already fixed it this turn. Use captured pendingDateYmd if the caller only repeated the time.`;
  } else if (!hasDoctor) {
    action = `NEXT_TURN: Ensure a doctor is chosen from list_doctors / search_doctors to match the visit reason; do not re-ask date/time if the caller already confirmed the same slot. One short ${lang} line to confirm doctor choice if needed, then move to section 8 single read-back.`;
  } else if (affirm && hasPatient && hasIso && hasDoctor) {
    const gate =
      "If you have NOT yet done the single section-8 read-back for this booking, do it once in " +
      lang +
      " before tools; if you already did and the caller confirmed, do not read the full block again.";
    if (!hasPatientOid) {
      action = `TOOL_NOW: ${gate} **Mandatory order:** (1) Call \`create_patient\` first with fullName, age, gender, reason (English) — wait for ok:true. (2) Then call \`create_appointment\` using **patientObjectId exactly equal to** the \`patient._id\` string from step 1 (24 hex characters from the tool JSON). **Never** call \`create_appointment\` before \`create_patient\` succeeds for a new patient; **never** use age, "1", or human patientId like P-2026-… as patientObjectId. Speak the short wait line in ${lang} before the tool(s). If an appointment was already booked earlier in this same call, later \`create_appointment\` **updates** that row — same rule: patientObjectId must still be the real Mongo id from \`create_patient\` or fetch.`;
    } else {
      action = `TOOL_NOW: ${gate} Speak the short wait line in ${lang}, then \`create_appointment\` with doctorObjectId, patientObjectId (valid Mongo id from create_patient or fetch), English reason, appointmentDateTimeISO. If this call already booked an appointment and the caller is changing details, this call **updates** that same appointment (do not create a second one).`;
    }
  } else if (affirm && hasPatient && hasIso && !hasDoctor) {
    action =
      "The caller said YES. BOOKING_CAPTURE has patient + time but no doctor id yet — take doctorObjectId from your latest list_doctors/search_doctors in this chat, or call list_doctors once. Then **create_patient** (if no valid patientObjectId yet) and **create_appointment** with patientObjectId from create_patient's patient._id. If section 8 was not spoken yet, do one read-back first; if they already confirmed, do not repeat the full summary.";
  } else if (affirm) {
    action = `The caller said YES but some booking IDs may still be only in your prior turns — complete tools without a second full read-back if section 8 was already done; otherwise one section-8 block only.`;
  } else {
    action = `NEXT_TURN: Continue efficiently in ${lang}; one new ask or one section-8 read-back only when prerequisites are met; never repeat the same summary twice after the caller already agreed.`;
  }

  return [
    "BOOKING_STATE (trust this for captured phone-call facts; still follow hospital safety rules):",
    snapshot,
    action,
    `Caller language for this turn: ${lang}. Stay in ${lang} for your whole reply (sorry, wait line, fillers) even if the user mixed a few English words.`,
  ].join("\n");
}

module.exports = {
  buildBookingTurnInstructions,
  getFirstMissingPatientField,
  getNoInputMissingTopic,
  formatSlotSnapshot,
};
