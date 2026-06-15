const WhatsAppTemplateAssignment = require("../models/whatsappTemplateAssignment.model");
const env = require("../config/env");

const TEMPLATE_KEYS = Object.freeze({
  APPOINTMENT_CONFIRMATION: "appointmentConfirmation",
  POST_OPD_PRESCRIPTION: "postOpdPrescription",
  MEDICINE_REMINDER: "medicineReminder",
  FINAL_MEDICINE_REMINDER: "finalMedicineReminder",
});

const TEMPLATE_KEY_LIST = Object.values(TEMPLATE_KEYS);

const TEMPLATE_CATALOG = Object.freeze({
  appointmentConfirmation: {
    key: TEMPLATE_KEYS.APPOINTMENT_CONFIRMATION,
    title: "APPOINTMENT CONFIRMATION",
    envNameKey: "APPOINTMENT_TEMPLATE_NAME",
    defaultName: "appointment_completed",
    body: [
      "Your appointment is confirmed, [Patient Name]!",
      "Date & Time: [Appointment Date & Time]",
      "Doctor: [Dr. Name]",
      "Location: [Hospital Address]",
      "Ref: [Patient ID]",
      "If you need to reschedule please select below option.",
    ],
    buttons: ["Reschedule"],
  },
  postOpdPrescription: {
    key: TEMPLATE_KEYS.POST_OPD_PRESCRIPTION,
    title: "POST OPD PRESCRIPTION",
    envNameKey: "PRESCRIPTION_TEMPLATE_NAME",
    defaultName: "prescription_created_message",
    body: [
      "Hi [Patient Name], your prescription from [Dr. Name] is ready.",
      "[Prescription Link]",
      "Take your medicines as prescribed.",
      "[Hospital Name] Care Team.",
    ],
  },
  medicineReminder: {
    key: TEMPLATE_KEYS.MEDICINE_REMINDER,
    title: "MEDICINE REMINDER",
    envNameKey: "MEDICINE_TEMPLATE_NAME",
    defaultName: "medicines_reminder_message",
    body: [
      "Hi [Patient Name], time for your medicine.",
      "[Medicine Details]",
      "Status shared with [Dr. Name].",
      "[Hospital Name] Care Team.",
    ],
    buttons: ["Taken", "Not Yet"],
  },
  finalMedicineReminder: {
    key: TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER,
    title: "FINAL MEDICINE REMINDER (COURSE COMPLETED)",
    envNameKey: "FINAL_MEDICINE_REMINDER_TEMPLATE_NAME",
    defaultName: "final_medicine_reminder",
    body: [
      "Hi [Patient Name], your prescribed medication course has been completed.",
      "Select your recovery status.",
      "[Hospital Name] Care Team.",
    ],
    buttons: ["Fully Recovered", "Not Yet"],
  },
});

function normalizeTemplateValue(v) {
  return typeof v === "string" ? v.trim() : "";
}

function getEnvTemplateLangByKey(templateKey) {
  const map = {
    [TEMPLATE_KEYS.APPOINTMENT_CONFIRMATION]: env.APPOINTMENT_TEMPLATE_LANG,
    [TEMPLATE_KEYS.POST_OPD_PRESCRIPTION]: env.PRESCRIPTION_TEMPLATE_LANG,
    [TEMPLATE_KEYS.MEDICINE_REMINDER]: env.MEDICINE_TEMPLATE_LANG,
    [TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER]: env.FINAL_MEDICINE_REMINDER_TEMPLATE_LANG,
  };
  return String(map[templateKey] || env.APPOINTMENT_TEMPLATE_LANG || "en_US").trim();
}

function getEnvTemplateNameByKey(templateKey) {
  const map = {
    [TEMPLATE_KEYS.APPOINTMENT_CONFIRMATION]: env.APPOINTMENT_TEMPLATE_NAME,
    [TEMPLATE_KEYS.POST_OPD_PRESCRIPTION]: env.PRESCRIPTION_TEMPLATE_NAME,
    [TEMPLATE_KEYS.MEDICINE_REMINDER]: env.MEDICINE_TEMPLATE_NAME,
    [TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER]: env.FINAL_MEDICINE_REMINDER_TEMPLATE_NAME,
  };
  return normalizeTemplateValue(map[templateKey]);
}

/** Template names from server .env only (assign + notify fallbacks). */
function getEnvTemplateNames() {
  const out = {};
  for (const key of TEMPLATE_KEY_LIST) {
    const name = getEnvTemplateNameByKey(key);
    if (name) out[key] = name;
  }
  return out;
}

function resolveTemplateNamesForAssignment() {
  return getEnvTemplateNames();
}

function buildNormalizedTemplatePayload() {
  return getEnvTemplateNames();
}

async function getAssignedTemplatesByPhoneNumberId({ hospitalId, phoneNumberId }) {
  if (!hospitalId || !phoneNumberId) return null;
  const doc = await WhatsAppTemplateAssignment.findOne({
    hospitalId,
    phone_number_id: String(phoneNumberId).trim(),
  }).lean();
  return doc || null;
}

async function getAssignedTemplateName({ hospitalId, phoneNumberId, templateKey }) {
  if (!templateKey) return "";
  const legacyKeyMap = {
    medicationCourseCompleted: TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER,
    dosageCompletion: TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER,
    dosageFollowupNotYet: TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER,
  };
  const resolvedKey = TEMPLATE_KEY_LIST.includes(templateKey)
    ? templateKey
    : legacyKeyMap[templateKey] || "";
  if (!resolvedKey) return "";

  const doc = await getAssignedTemplatesByPhoneNumberId({ hospitalId, phoneNumberId });
  const legacyAssignmentKeys = {
    [TEMPLATE_KEYS.FINAL_MEDICINE_REMINDER]: [
      "finalMedicineReminder",
      "medicationCourseCompleted",
      "dosageCompletion",
      "dosageFollowupNotYet",
    ],
  };
  const keysToTry = [resolvedKey, ...(legacyAssignmentKeys[resolvedKey] || [])];
  for (const key of keysToTry) {
    const name = normalizeTemplateValue(doc?.templates?.[key]);
    if (name) return name;
  }
  return getEnvTemplateNameByKey(resolvedKey);
}

module.exports = {
  TEMPLATE_KEYS,
  TEMPLATE_KEY_LIST,
  TEMPLATE_CATALOG,
  getEnvTemplateNameByKey,
  getEnvTemplateLangByKey,
  getEnvTemplateNames,
  resolveTemplateNamesForAssignment,
  buildNormalizedTemplatePayload,
  getAssignedTemplatesByPhoneNumberId,
  getAssignedTemplateName,
};
