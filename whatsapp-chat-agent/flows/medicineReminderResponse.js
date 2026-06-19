/**
 * Auto-replies when a patient taps quick-reply buttons on the medicine reminder template.
 * All copy is English (WhatsApp care messages).
 */

const MEDICINE_REMINDER_TAKEN_RE = /^\s*taken\s*$/i;
const MEDICINE_REMINDER_NOT_YET_RE = /^\s*not\s+yet\s*$/i;
const DOSAGE_COMPLETION_RECOVERED_RE = /^\s*fully\s+recovered\s*$/i;

/**
 * @param {string} text - button title or user text
 * @param {string} [buttonId] - Meta quick-reply payload / id when available
 * @returns {'taken'|'not_yet'|null}
 */
function detectMedicineReminderButtonReply(text, buttonId, ctx) {
  const t = String(text || "").trim();
  const id = String(buttonId || "").trim().toLowerCase();

  if (DOSAGE_COMPLETION_RECOVERED_RE.test(t) || id.includes("fully_recovered")) {
    return null;
  }

  if (ctx?.activeFlow === "dosage_completion" || ctx?.activeFlow === "dosage_followup") {
    return null;
  }

  if (MEDICINE_REMINDER_TAKEN_RE.test(t) || id === "taken") {
    return "taken";
  }

  if (MEDICINE_REMINDER_NOT_YET_RE.test(t) || id === "not_yet" || id === "not yet") {
    if (id.includes("dosage") || id.includes("followup") || id.includes("follow_up")) {
      return null;
    }
    return "not_yet";
  }

  return null;
}

function formatHospitalSignOff(hospitalName) {
  const name = hospitalName?.trim();
  return name ? `\n— ${name}` : "";
}

/**
 * @param {string} [hospitalName]
 * @returns {string}
 */
function buildMedicineReminderTakenReply(hospitalName) {
  return [
    "Thank you for letting us know.",
    "",
    "We have recorded that you have taken your medicine. Please continue to follow your doctor's instructions — staying consistent supports a safe and effective recovery.",
    "",
    "If you have any questions, our care team is here to help.",
    formatHospitalSignOff(hospitalName),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {string} [hospitalName]
 * @returns {string}
 */
function buildMedicineReminderNotTakenReply(hospitalName) {
  return [
    "Thank you for your response.",
    "",
    "Please take your medicines on time as prescribed by your doctor. Regular doses help you recover safely and effectively.",
    "",
    "If you need any assistance, please contact our care team.",
    formatHospitalSignOff(hospitalName),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {'taken'|'not_yet'} kind
 * @param {string} [hospitalName]
 * @returns {string}
 */
function buildMedicineReminderButtonReply(kind, hospitalName) {
  if (kind === "taken") {
    return buildMedicineReminderTakenReply(hospitalName);
  }
  return buildMedicineReminderNotTakenReply(hospitalName);
}

module.exports = {
  detectMedicineReminderButtonReply,
  buildMedicineReminderTakenReply,
  buildMedicineReminderNotTakenReply,
  buildMedicineReminderButtonReply,
};
