const Hospital = require("../models/hospital.model");
const WhatsApp = require("../models/whatsapp.model");
const env = require("../config/env");
const {
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
} = require("../utils/hospitalMessagingSettings");
const { buildPrescriptionPublicLink } = require("../utils/prescriptionPublicLink");
const {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  templateBodyNamedParameters,
  normalizeWhatsAppTo,
} = require("./whatsappCloud");

/** When / frequency: meal slots + intake; avoid repeating the same text as stored `frequency`. */
function buildConsumptionSummary(medicine) {
  const parts = [];
  if (medicine.intake && String(medicine.intake).trim()) {
    parts.push(`${String(medicine.intake).trim()} food`);
  }
  if (medicine.time && typeof medicine.time === "object") {
    if (medicine.time.breakfast) parts.push("Breakfast");
    if (medicine.time.lunch) parts.push("Lunch");
    if (medicine.time.dinner) parts.push("Dinner");
  }
  const slots = parts.join(" • ");
  const freq =
    typeof medicine.frequency === "string" && medicine.frequency.trim()
      ? medicine.frequency.trim()
      : "";

  if (!freq || freq === "As directed") return slots || "As directed";

  const norm = (s) =>
    s.replace(/\s+/g, " ").trim().toLowerCase().replace(/,/g, " ");
  const slotsNorm = norm(slots);
  const freqNorm = norm(freq);

  if (slots && (freqNorm === slotsNorm || freqNorm.startsWith(slotsNorm + " "))) return freq;
  if (slots && slotsNorm && freqNorm.includes(slotsNorm)) return freq;
  if (slots) return `${slots} • ${freq}`;
  return freq;
}

function formatDosage(dosage) {
  if (dosage == null || dosage === "") return null;
  if (typeof dosage === "string") return dosage.trim() || null;
  if (typeof dosage === "object" && dosage !== null) {
    if (dosage.value != null && dosage.value !== "") {
      const u = dosage.unit ? String(dosage.unit).trim() : "";
      return u ? `${dosage.value} ${u}` : String(dosage.value);
    }
  }
  return null;
}

function formatDuration(duration) {
  if (duration == null || duration === "") return null;
  if (typeof duration === "string") return duration.trim() || null;
  if (typeof duration === "object" && duration !== null && duration.value != null) {
    const u = duration.unit ? String(duration.unit).trim() : "";
    return u ? `${duration.value} ${u}` : String(duration.value);
  }
  return null;
}

function formatDoctorDisplayName(fullName) {
  const name = fullName?.trim();
  if (!name) return "Doctor";
  if (/^dr\.?\s/i.test(name)) return name;
  return `Dr. ${name}`;
}

function buildPrescriptionWhatsAppText(prescription, hospitalName) {
  const patientName =
    (prescription.patientName && prescription.patientName.trim()) ||
    prescription.patient?.fullName?.trim() ||
    "Patient";
  const facility = hospitalName?.trim() || "Hospital";
  const apptRef =
    prescription.appointment && typeof prescription.appointment === "object"
      ? prescription.appointment.appointmentId
      : null;

  const medLines = (Array.isArray(prescription.medicines) ? prescription.medicines : []).map(
    (m, i) => {
      const dosage = formatDosage(m.dosage);
      const duration = formatDuration(m.duration);
      const when = buildConsumptionSummary(m);
      const lines = [
        `*${i + 1}. ${m.name}*`,
        `   • When / frequency: ${when}`,
      ];
      if (dosage) lines.push(`   • Dosage: ${dosage}`);
      if (duration) {
        const w = when.toLowerCase();
        const d = duration.toLowerCase();
        if (!w.includes(d)) {
          lines.push(`   • Duration: ${duration}`);
        }
      }
      if (m.notes && String(m.notes).trim()) {
        lines.push(`   • Note: ${String(m.notes).trim()}`);
      }
      return lines.join("\n");
    }
  );

  const header = [
    `Dear ${patientName},`,
    "",
    `Your prescription from *${facility}* is ready.`,
    apptRef ? `Reference (visit): *${apptRef}*` : null,
    "",
    "*Your medicines*",
    "",
  ].filter(Boolean);

  const footer = [
    "",
    prescription.notes && String(prescription.notes).trim()
      ? `*General instructions:* ${String(prescription.notes).trim()}`
      : null,
    "",
    "Take medicines exactly as prescribed. Do not skip doses or stop early without consulting your doctor.",
    "If you notice side effects or have questions, contact the hospital promptly.",
    "",
    `— ${facility}`,
  ].filter((line) => line !== null);

  return [...header, ...medLines, ...footer].join("\n");
}

/**
 * WhatsApp after prescription create (appointment-linked only).
 * Uses NAMED template `PRESCRIPTION_TEMPLATE_NAME` when set (patient_name, doctor_name, link).
 */
async function notifyPrescriptionCreated(prescription) {
  if (!prescription?.patient?.phoneNumber) {
    return;
  }

  const hospitalId = prescription.hospital?._id || prescription.hospital;
  if (!hospitalId) {
    return;
  }

  const [creds, hospital, perm] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    prescription.hospital && typeof prescription.hospital === "object" && prescription.hospital.name
      ? Promise.resolve(prescription.hospital)
      : Hospital.findById(hospitalId).select("name phoneCountryCode").lean(),
    getResolvedHospitalMessagingSettings(hospitalId),
  ]);

  if (!perm.whatsapp.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_disabled", { flow: "prescription_confirmation" });
    return;
  }
  if (!perm.whatsapp.prescription) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_prescription", { flow: "prescription_confirmation" });
    return;
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    return;
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(prescription.patient.phoneNumber, ccDigits);
  if (!to) {
    console.warn("[WhatsApp] Prescription notify: invalid patient phone");
    return;
  }

  const hospitalName = hospital?.name || "Hospital";
  const patientName =
    (prescription.patientName && String(prescription.patientName).trim()) ||
    prescription.patient?.fullName?.trim() ||
    "Patient";

  let doctorName = "Doctor";
  const appt = prescription.appointment;
  if (appt && typeof appt === "object" && appt.doctor && typeof appt.doctor === "object") {
    doctorName = formatDoctorDisplayName(appt.doctor.fullName);
  }

  const link = buildPrescriptionPublicLink(prescription._id);
  const templateName = env.PRESCRIPTION_TEMPLATE_NAME;

  if (templateName) {
    await sendWhatsAppTemplate({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: prescription.patient.phoneNumber,
      templateName,
      languageCode: env.PRESCRIPTION_TEMPLATE_LANG,
      components: templateBodyNamedParameters({
        patient_name: patientName,
        doctor_name: doctorName,
        link,
      }),
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
    return;
  }

  const textBody = buildPrescriptionWhatsAppText(prescription, hospitalName);

  await sendWhatsAppText({
    phoneNumberId: creds.phone_number_id,
    accessToken: creds.access_token,
    to: prescription.patient.phoneNumber,
    textBody,
    defaultCountryDigits: ccDigits,
    apiVersion: creds.api_version || undefined,
  });
}

module.exports = { notifyPrescriptionCreated };
