const Appointment = require("../models/appointment.model");
const Hospital = require("../models/hospital.model");
const WhatsApp = require("../models/whatsapp.model");
const env = require("../config/env");
const {
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
} = require("../utils/hospitalMessagingSettings");
const {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  templateBodyNamedParameters,
  normalizeWhatsAppTo,
} = require("./whatsappCloud");

const APPOINTMENT_TZ = "Asia/Kolkata";

function formatAppointmentDateTime(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate).toLocaleString("en-IN", {
      timeZone: APPOINTMENT_TZ,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(isoDate);
  }
}

function formatAppointmentDateOnly(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate).toLocaleDateString("en-IN", {
      timeZone: APPOINTMENT_TZ,
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return String(isoDate);
  }
}

function formatAppointmentTimeOnly(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate).toLocaleTimeString("en-IN", {
      timeZone: APPOINTMENT_TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(isoDate);
  }
}

function formatDoctorDisplayName(fullName) {
  const name = fullName?.trim() || "your specialist";
  if (/^dr\.?\s/i.test(name)) return name;
  return `Dr. ${name}`;
}

function buildAppointmentConfirmationText(appointment, hospitalName) {
  const patientName = appointment.patient?.fullName?.trim() || "Valued patient";
  const doctorDisplay = formatDoctorDisplayName(appointment.doctor?.fullName);
  const ref = appointment.appointmentId || "—";
  const when = formatAppointmentDateTime(appointment.appointmentDateTime);
  const facility = hospitalName?.trim() || "our facility";

  return [
    `Dear ${patientName},`,
    "",
    `Thank you for choosing *${facility}*. Your appointment has been confirmed.`,
    "",
    "*Appointment details*",
    `• Patient: ${patientName}`,
    `• Doctor: ${doctorDisplay}`,
    `• Date & time: ${when}`,
    `• Reference no.: ${ref}`,
    "",
    "Please arrive 10–15 minutes before your scheduled time. If you need to change or cancel this appointment, kindly contact the hospital as soon as possible.",
    "",
    "We look forward to seeing you.",
    "",
    `— ${facility}`,
  ].join("\n");
}

/** Razorpay tele-caller flow: paid video booking with Meet link in body (plain text; includes link). */
function buildTeleCallerAppointmentBookedText(appointment, hospitalName) {
  const patientName = appointment.patient?.fullName?.trim() || "Valued patient";
  const doctorDisplay = formatDoctorDisplayName(appointment.doctor?.fullName);
  const ref = appointment.appointmentId || "—";
  const when = formatAppointmentDateTime(appointment.appointmentDateTime);
  const facility = hospitalName?.trim() || "our facility";
  const link = appointment.videoUrl?.trim();

  const lines = [
    `Dear ${patientName},`,
    "",
    `Your *tele-caller* appointment has been booked with *${facility}*.`,
    "",
    "*Appointment details*",
    `• Patient: ${patientName}`,
    `• Doctor: ${doctorDisplay}`,
    `• Date & time: ${when}`,
    `• Reference no.: ${ref}`,
  ];
  if (link) {
    lines.push(`• Meeting link: ${link}`);
  }
  lines.push(
    "",
    "Please use the meeting link at the scheduled time if provided. To reschedule or cancel, contact the hospital.",
    "",
    `— ${facility}`,
  );
  return lines.join("\n");
}

/**
 * After an appointment is created: if the hospital has WhatsApp Cloud creds, notify the patient.
 * Uses NAMED template `APPOINTMENT_TEMPLATE_NAME` when set; otherwise plain text.
 * @param {object} appointment - lean doc with populated `patient`, `doctor`, optional `hospital`
 */
async function notifyAppointmentBooked(appointment) {
  if (!appointment?.patient?.phoneNumber) {
    return;
  }

  const hospitalId = appointment.hospital?._id || appointment.hospital;
  if (!hospitalId) {
    return;
  }

  const [creds, hospital, perm] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    appointment.hospital && typeof appointment.hospital === "object" && appointment.hospital.name
      ? Promise.resolve(appointment.hospital)
      : Hospital.findById(hospitalId).select("name phoneCountryCode").lean(),
    getResolvedHospitalMessagingSettings(hospitalId),
  ]);

  if (!perm.whatsapp.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_disabled", { flow: "appointment_confirmation" });
    return;
  }
  if (!perm.whatsapp.appointment) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_appointment", { flow: "appointment_confirmation" });
    return;
  }
  if (appointment.type === "tele-caller" && !perm.teleCaller.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "telecaller_disabled", {
      flow: "appointment_confirmation",
      appointmentType: "tele-caller",
    });
    return;
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    return;
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(appointment.patient.phoneNumber, ccDigits);
  if (!to) {
    console.warn("[WhatsApp] Appointment notify: invalid patient phone");
    return;
  }

  const hospitalName = hospital?.name || "Hospital";
  const patientName = appointment.patient?.fullName?.trim() || "Valued patient";
  const doctorDisplay = formatDoctorDisplayName(appointment.doctor?.fullName);
  const ref = appointment.appointmentId || "—";
  const dt = appointment.appointmentDateTime;

  const templateName = env.APPOINTMENT_TEMPLATE_NAME;

  if (appointment.type === "tele-caller") {
    const textBody = buildTeleCallerAppointmentBookedText(appointment, hospitalName);
    await sendWhatsAppText({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: appointment.patient.phoneNumber,
      textBody,
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
    return;
  }

  if (templateName) {
    await sendWhatsAppTemplate({
      phoneNumberId: creds.phone_number_id,
      accessToken: creds.access_token,
      to: appointment.patient.phoneNumber,
      templateName,
      languageCode: env.APPOINTMENT_TEMPLATE_LANG,
      components: templateBodyNamedParameters({
        patient_name: patientName,
        doctor_name: doctorDisplay,
        appointment_date: formatAppointmentDateOnly(dt),
        appointment_time: formatAppointmentTimeOnly(dt),
        reference_id: ref,
      }),
      defaultCountryDigits: ccDigits,
      apiVersion: creds.api_version || undefined,
    });
    return;
  }

  const textBody = buildAppointmentConfirmationText(appointment, hospitalName);

  await sendWhatsAppText({
    phoneNumberId: creds.phone_number_id,
    accessToken: creds.access_token,
    to: appointment.patient.phoneNumber,
    textBody,
    defaultCountryDigits: ccDigits,
    apiVersion: creds.api_version || undefined,
  });
}

/**
 * Load appointment + relations, then send the same notification as API booking (agent / voice flows).
 * WhatsApp row is resolved by `hospital` on the appointment (same hospitalId as the agent uses).
 */
async function notifyAppointmentBookedById(appointmentId) {
  if (!appointmentId) return;

  const populated = await Appointment.findById(appointmentId)
    .populate("doctor", "fullName doctorId designation")
    .populate("patient", "fullName patientId phoneNumber age gender")
    .populate("hospital", "name phoneCountryCode")
    .populate("paymentId", "payment_id order_id amount status paymentDate createdAt")
    .lean();

  if (!populated) {
    console.warn("[WhatsApp] Appointment notify: appointment not found", String(appointmentId));
    return;
  }

  return notifyAppointmentBooked(populated);
}

module.exports = { notifyAppointmentBooked, notifyAppointmentBookedById };
