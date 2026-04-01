const Appointment = require("../models/appointment.model");
const Hospital = require("../models/hospital.model");
const WhatsApp = require("../models/whatsapp.model");
const { sendWhatsAppText, normalizeWhatsAppTo } = require("./whatsappCloud");

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

/**
 * After an appointment is created: if the hospital has WhatsApp Cloud creds, notify the patient (text only).
 * Failures are logged only; booking always succeeds.
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

  const [creds, hospital] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    appointment.hospital && typeof appointment.hospital === "object" && appointment.hospital.name
      ? Promise.resolve(appointment.hospital)
      : Hospital.findById(hospitalId).select("name phoneCountryCode").lean(),
  ]);

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
 * Load appointment + relations, then send the same text as API booking (agent / voice flows).
 * WhatsApp row is resolved by `hospital` on the appointment (same hospitalId as the agent uses).
 */
async function notifyAppointmentBookedById(appointmentId) {
  if (!appointmentId) return;

  const populated = await Appointment.findById(appointmentId)
    .populate("doctor", "fullName doctorId designation")
    .populate("patient", "fullName patientId phoneNumber age gender")
    .populate("hospital", "name phoneCountryCode")
    .lean();

  if (!populated) {
    console.warn("[WhatsApp] Appointment notify: appointment not found", String(appointmentId));
    return;
  }

  return notifyAppointmentBooked(populated);
}

module.exports = { notifyAppointmentBooked, notifyAppointmentBookedById };
