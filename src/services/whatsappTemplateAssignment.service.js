const WhatsAppTemplateAssignment = require("../models/whatsappTemplateAssignment.model");

const TEMPLATE_KEYS = Object.freeze({
  APPOINTMENT_CONFIRMATION: "appointmentConfirmation",
  POST_OPD_PRESCRIPTION: "postOpdPrescription",
  MEDICINE_REMINDER: "medicineReminder",
  DOSAGE_COMPLETION: "dosageCompletion",
  DOSAGE_FOLLOWUP_NOT_YET: "dosageFollowupNotYet",
});

const TEMPLATE_KEY_LIST = Object.values(TEMPLATE_KEYS);

const TEMPLATE_CATALOG = Object.freeze({
  appointmentConfirmation: {
    key: TEMPLATE_KEYS.APPOINTMENT_CONFIRMATION,
    title: "APPOINTMENT CONFIRMATION",
    body: [
      "Your Appointment is confirmed, [Patient Name]!",
      "Date & Time: [Appointment Date & Time]",
      "Doctor: [Dr. Name]",
      "Location: [Hospital Address]",
      "Ref: [Patient ID]",
      'If you need to reschedule please select "Reschedule".',
    ],
    buttons: ["Reschedule"],
    followups: [
      "If Reschedule: To reschedule, please provide a new date and time. Ex: 8 June, 11:30 AM",
    ],
  },
  postOpdPrescription: {
    key: TEMPLATE_KEYS.POST_OPD_PRESCRIPTION,
    title: "POST OPD",
    body: [
      "Hi [Patient Name], your prescription from [Dr. Name] is ready.",
      "[Prescription Link]",
      "Take your medicines as prescribed. Get well soon.",
    ],
    footer: "[Hospital Name]",
  },
  medicineReminder: {
    key: TEMPLATE_KEYS.MEDICINE_REMINDER,
    title: "MEDICINE REMINDER",
    body: [
      "Hi [Patient Name], time for your medicine.",
      "[Medicine Name] - [mg] | [Before/After] food | [Breakfast/Lunch/Dinner]",
      "Did you take it? Your response is tracked and shared with [Dr. Name].",
    ],
    footer: "[Hospital Name]",
    buttons: ["Taken"],
    followups: [
      "If Taken: Recorded. Keep it up, consistency speeds up recovery.",
    ],
  },
  dosageCompletion: {
    key: TEMPLATE_KEYS.DOSAGE_COMPLETION,
    title: "DOSAGE COMPLETION",
    body: [
      "Hi [Patient Name], you have finished your medication course.",
      "How are you feeling?",
    ],
    footer: "[Hospital Name]",
    buttons: ["Fully Recovered", "Not Yet"],
    followups: [
      "If Fully Recovered: Great to hear, [Patient Name]. [Dr. Name] will be pleased.",
      "Please share your feedback: [Link]",
      "If Not Yet: Let's get you a follow-up with [Dr. Name].",
      "Buttons: [Tele-Consultation], [In-Person Visit]",
    ],
  },
  dosageFollowupNotYet: {
    key: TEMPLATE_KEYS.DOSAGE_FOLLOWUP_NOT_YET,
    title: "DOSAGE FOLLOWUP NOT YET",
    body: [
      "Lets get you a follow-up with [Dr. Name].",
      "Choose your preferred follow-up mode.",
    ],
    footer: "[Hospital Name]",
    buttons: ["Tele-Consultation", "In-Person Visit"],
  },
});

function normalizeTemplateValue(v) {
  return typeof v === "string" ? v.trim() : "";
}

function buildNormalizedTemplatePayload(rawTemplates = {}) {
  const out = {};
  for (const key of TEMPLATE_KEY_LIST) {
    if (rawTemplates[key] !== undefined) {
      out[key] = normalizeTemplateValue(rawTemplates[key]);
    }
  }
  return out;
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
  if (!templateKey || !TEMPLATE_KEY_LIST.includes(templateKey)) return "";
  const doc = await getAssignedTemplatesByPhoneNumberId({ hospitalId, phoneNumberId });
  const name = doc?.templates?.[templateKey];
  return normalizeTemplateValue(name);
}

module.exports = {
  TEMPLATE_KEYS,
  TEMPLATE_KEY_LIST,
  TEMPLATE_CATALOG,
  buildNormalizedTemplatePayload,
  getAssignedTemplatesByPhoneNumberId,
  getAssignedTemplateName,
};
