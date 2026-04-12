const { UnrecoverableError } = require("bullmq");
const Hospital = require("../models/hospital.model");
const WhatsApp = require("../models/whatsapp.model");
const env = require("../config/env");
const {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  templateBodyNamedParameters,
  normalizeWhatsAppTo,
} = require("./whatsappCloud");
const {
  buildMedicineReminderWhatsAppBody,
  buildMedicineReminderTemplateMedicinesParam,
  buildFeedbackMessage,
} = require("./reminder.service");
const {
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
} = require("../utils/hospitalMessagingSettings");

/**
 * @param {import('mongoose').Document|object} prescription
 * @param {'breakfast'|'lunch'|'dinner'} slot
 * @param {{ name: string, dosage?: string, intake?: string }[]} medicines
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function notifyMedicineReminder(prescription, slot, medicines) {
  const patient = prescription.patient;
  const rxId = String(prescription._id || "");

  if (!patient?.phoneNumber) {
    const msg = `[WhatsApp] Medicine reminder: no patient phone (prescription ${rxId})`;
    console.warn(msg);
    throw new UnrecoverableError(msg);
  }

  const hospitalId =
    prescription.hospital?._id ||
    prescription.hospital ||
    patient.hospital ||
    null;

  if (!hospitalId) {
    const msg = `[WhatsApp] Medicine reminder: no hospital on prescription or patient (${rxId})`;
    console.warn(msg);
    throw new UnrecoverableError(msg);
  }

  const [creds, hospital, perm] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    prescription.hospital && typeof prescription.hospital === "object" && prescription.hospital.name
      ? Promise.resolve(prescription.hospital)
      : Hospital.findById(hospitalId).select("name phoneCountryCode").lean(),
    getResolvedHospitalMessagingSettings(hospitalId),
  ]);

  if (!perm.whatsapp.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_disabled", {
      flow: "medicine_reminder",
      prescriptionId: rxId,
    });
    const msg = `[Hospital settings] Medicine reminder denied: WhatsApp disabled (prescription ${rxId})`;
    throw new UnrecoverableError(msg);
  }
  if (!perm.whatsapp.medicinesReminder) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_medicines_reminder", {
      flow: "medicine_reminder",
      prescriptionId: rxId,
    });
    const msg = `[Hospital settings] Medicine reminder denied: medicinesReminder off (prescription ${rxId})`;
    throw new UnrecoverableError(msg);
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    const msg = `[WhatsApp] Medicine reminder: no WhatsApp Cloud row for hospital ${hospitalId} (phone_number_id + access_token). Prescription ${rxId}`;
    console.warn(msg);
    throw new UnrecoverableError(msg);
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(patient.phoneNumber, ccDigits);
  if (!to) {
    const msg = `[WhatsApp] Medicine reminder: invalid patient phone (${rxId})`;
    console.warn(msg);
    throw new UnrecoverableError(msg);
  }

  const patientName =
    (prescription.patientName && String(prescription.patientName).trim()) ||
    (typeof patient.fullName === "string" && patient.fullName.trim()) ||
    "Patient";

  const templateName = env.MEDICINE_TEMPLATE_NAME;
  const medsList = buildMedicineReminderTemplateMedicinesParam(slot, medicines || []);

  if (templateName) {
    await sendWhatsAppTemplate({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: patient.phoneNumber,
      templateName,
      languageCode: env.MEDICINE_TEMPLATE_LANG,
      components: templateBodyNamedParameters({
        patient_name: patientName,
        medicines: medsList,
      }),
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
  } else {
    const textBody = buildMedicineReminderWhatsAppBody(patientName, slot, medicines || []);
    await sendWhatsAppText({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: patient.phoneNumber,
      textBody,
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
  }

  console.log("[WhatsApp] Medicine reminder sent", {
    prescriptionId: rxId,
    slot,
    meds: (medicines || []).length,
    template: Boolean(templateName),
    templateName: templateName || null,
  });

  return { sent: true };
}

/**
 * End-of-course feedback message (plain text; no template env defined by product).
 * @param {import('mongoose').Document|object} prescription
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function notifyPrescriptionReminderFeedback(prescription) {
  const patient = prescription.patient;
  if (!patient?.phoneNumber) {
    console.warn("[WhatsApp] Reminder feedback: no patient phone", String(prescription._id));
    return { sent: false, reason: "no_phone" };
  }

  const hospitalId =
    prescription.hospital?._id ||
    prescription.hospital ||
    patient.hospital ||
    null;

  if (!hospitalId) {
    console.warn("[WhatsApp] Reminder feedback: no hospital", String(prescription._id));
    return { sent: false, reason: "no_hospital" };
  }

  const [creds, hospital, perm] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    prescription.hospital && typeof prescription.hospital === "object" && prescription.hospital.name
      ? Promise.resolve(prescription.hospital)
      : Hospital.findById(hospitalId).select("name phoneCountryCode").lean(),
    getResolvedHospitalMessagingSettings(hospitalId),
  ]);

  if (!perm.whatsapp.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_disabled", {
      flow: "prescription_reminder_feedback",
      prescriptionId: String(prescription._id),
    });
    throw new UnrecoverableError(
      `[Hospital settings] Reminder feedback denied: WhatsApp disabled (prescription ${String(prescription._id)})`
    );
  }
  if (!perm.whatsapp.medicinesReminder) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_medicines_reminder", {
      flow: "prescription_reminder_feedback",
      prescriptionId: String(prescription._id),
    });
    throw new UnrecoverableError(
      `[Hospital settings] Reminder feedback denied: medicinesReminder off (prescription ${String(prescription._id)})`
    );
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    console.warn("[WhatsApp] Reminder feedback: WhatsApp not configured", String(hospitalId));
    return { sent: false, reason: "no_whatsapp_creds" };
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(patient.phoneNumber, ccDigits);
  if (!to) {
    console.warn("[WhatsApp] Reminder feedback: invalid phone", String(prescription._id));
    return { sent: false, reason: "invalid_phone" };
  }

  const patientName =
    (prescription.patientName && String(prescription.patientName).trim()) ||
    (typeof patient.fullName === "string" && patient.fullName.trim()) ||
    "Patient";

  const textBody = buildFeedbackMessage(patientName);

  await sendWhatsAppText({
    phoneNumberId: creds.phone_number_id,
    accessToken: creds.access_token,
    to: patient.phoneNumber,
    textBody,
    defaultCountryDigits: ccDigits,
    apiVersion: creds.api_version || undefined,
  });

  console.log("[WhatsApp] Reminder feedback sent", { prescriptionId: String(prescription._id) });
  return { sent: true };
}

module.exports = { notifyMedicineReminder, notifyPrescriptionReminderFeedback };
