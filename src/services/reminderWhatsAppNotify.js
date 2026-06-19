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
} = require("./reminder.service");
const { setDosageCompletionPending } = require("../../whatsapp-chat-agent/services/contextService");
const {
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
} = require("../utils/hospitalMessagingSettings");
const {
  TEMPLATE_KEYS,
  getAssignedTemplateName,
} = require("./whatsappTemplateAssignment.service");

function formatDoctorDisplayName(fullName) {
  const name = fullName?.trim();
  if (!name) return "Doctor";
  if (/^dr\.?\s/i.test(name)) return name;
  return `Dr. ${name}`;
}

function resolveDoctorName(prescription) {
  const appt = prescription.appointment;
  if (appt && typeof appt === "object" && appt.doctor && typeof appt.doctor === "object") {
    return formatDoctorDisplayName(appt.doctor.fullName);
  }
  return "Doctor";
}

function resolveDoctorId(prescription) {
  const appt = prescription.appointment;
  if (appt && typeof appt === "object" && appt.doctor) {
    if (typeof appt.doctor === "object" && appt.doctor._id) {
      return String(appt.doctor._id);
    }
    return String(appt.doctor);
  }
  return null;
}

function resolveContextPhoneKey(patientPhone, ccDigits) {
  return (
    normalizeWhatsAppTo(patientPhone, ccDigits) ||
    String(patientPhone || "").replace(/\D/g, "") ||
    ""
  );
}

function buildDosageCompletionFallbackText(patientName, hospitalName) {
  const name = patientName?.trim() || "there";
  const facility = hospitalName?.trim() || "Hospital";
  return [
    `Hi ${name},`,
    "",
    "You have finished your prescribed medicine course.",
    "",
    "How are you feeling now?",
    "",
    "Please reply with *Fully Recovered* or *Not Yet*.",
    "",
    `— ${facility} Care Team`,
  ].join("\n");
}

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
  const hospitalName = hospital?.name || "Hospital";
  const doctorName = resolveDoctorName(prescription);

  const assignedTemplateName = await getAssignedTemplateName({
    hospitalId,
    phoneNumberId: creds.phone_number_id,
    templateKey: TEMPLATE_KEYS.MEDICINE_REMINDER,
  });
  const templateName = assignedTemplateName || env.MEDICINE_TEMPLATE_NAME;
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
        medicine_details: medsList,
        doctor_name: doctorName,
        hospital_name: hospitalName,
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
 * End-of-course dosage completion message (template with Fully Recovered / Not Yet).
 * @param {import('mongoose').Document|object} prescription
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function notifyPrescriptionReminderFeedback(prescription) {
  const rxId = String(prescription._id || "");
  const patient = prescription.patient;
  if (!patient?.phoneNumber) {
    console.warn("[WhatsApp] Dosage completion: no patient phone", rxId);
    return { sent: false, reason: "no_phone" };
  }

  const hospitalId =
    prescription.hospital?._id ||
    prescription.hospital ||
    patient.hospital ||
    null;

  if (!hospitalId) {
    console.warn("[WhatsApp] Dosage completion: no hospital", rxId);
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
      flow: "dosage_completion",
      prescriptionId: rxId,
    });
    throw new UnrecoverableError(
      `[Hospital settings] Dosage completion denied: WhatsApp disabled (prescription ${rxId})`
    );
  }
  if (!perm.whatsapp.medicinesReminder) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_medicines_reminder", {
      flow: "dosage_completion",
      prescriptionId: rxId,
    });
    throw new UnrecoverableError(
      `[Hospital settings] Dosage completion denied: medicinesReminder off (prescription ${rxId})`
    );
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    console.warn("[WhatsApp] Dosage completion: WhatsApp not configured", String(hospitalId));
    return { sent: false, reason: "no_whatsapp_creds" };
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(patient.phoneNumber, ccDigits);
  if (!to) {
    console.warn("[WhatsApp] Dosage completion: invalid phone", rxId);
    return { sent: false, reason: "invalid_phone" };
  }

  const patientName =
    (prescription.patientName && String(prescription.patientName).trim()) ||
    (typeof patient.fullName === "string" && patient.fullName.trim()) ||
    "Patient";
  const hospitalName = hospital?.name || "Hospital";
  const doctorName = resolveDoctorName(prescription);
  const doctorId = resolveDoctorId(prescription);
  const patientId =
    patient && typeof patient === "object" && patient._id ? String(patient._id) : String(prescription.patient || "");

  const assignedTemplateName = await getAssignedTemplateName({
    hospitalId,
    phoneNumberId: creds.phone_number_id,
    templateKey: TEMPLATE_KEYS.DOSAGE_COMPLETION,
  });
  const templateName = assignedTemplateName || env.DOSAGE_COMPLETION_TEMPLATE_NAME;

  if (templateName) {
    await sendWhatsAppTemplate({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: patient.phoneNumber,
      templateName,
      languageCode: env.DOSAGE_COMPLETION_TEMPLATE_LANG,
      components: templateBodyNamedParameters({
        patient_name: patientName,
        doctor_name: doctorName,
        hospital_name: hospitalName,
      }),
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
  } else {
    const textBody = buildDosageCompletionFallbackText(patientName, hospitalName);
    await sendWhatsAppText({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: patient.phoneNumber,
      textBody,
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
  }

  const phoneKey = resolveContextPhoneKey(patient.phoneNumber, ccDigits);
  if (phoneKey) {
    setDosageCompletionPending(phoneKey, {
      prescriptionId: rxId,
      patientId,
      patientName,
      doctorId,
      doctorName,
      hospitalName,
      hospitalId: String(hospitalId),
    });
  }

  console.log("[WhatsApp] Dosage completion sent", {
    prescriptionId: rxId,
    templateName: templateName || null,
  });
  return { sent: true };
}

module.exports = { notifyMedicineReminder, notifyPrescriptionReminderFeedback };
