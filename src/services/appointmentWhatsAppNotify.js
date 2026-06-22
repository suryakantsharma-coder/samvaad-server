const Appointment = require("../models/appointment.model");
const Hospital = require("../models/hospital.model");
const WhatsApp = require("../models/whatsapp.model");
// Register the models this service populates (patient, doctor, paymentId) so it
// works in standalone worker processes (e.g. the appointment-confirmation worker),
// not just in the API where the full app loads every model. Without these,
// .populate() throws "Schema hasn't been registered for model ...".
require("../models/patient.model");
require("../models/doctor.model");
require("../models/paymentHistory.model");
const env = require("../config/env");
const {
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
} = require("../utils/hospitalMessagingSettings");
const {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  templateBodyNamedParameters,
  templateBodyParameters,
  normalizeWhatsAppTo,
} = require("./whatsappCloud");
const {
  TEMPLATE_KEYS,
  getAssignedTemplateName,
} = require("./whatsappTemplateAssignment.service");

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

/** Single-line address for WhatsApp template {{hospital_address}}. */
function formatHospitalAddress(hospital, hospitalName) {
  if (hospital && typeof hospital === "object") {
    const parts = [
      hospital.address,
      hospital.city,
      hospital.state,
      hospital.pincode,
    ]
      .map((p) => (p != null ? String(p).trim() : ""))
      .filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return hospitalName?.trim() || "—";
}

/**
 * Body components for Meta template `appointment_confirmation_message_*`.
 * Named placeholders: patient_name, appointment_datetime, doctor_name, hospital_address, patient_id.
 * Positional order matches TEMPLATE_CATALOG body slots ({{1}}…{{5}}).
 */
function buildAppointmentTemplateComponents({
  patientName,
  doctorDisplay,
  appointmentDateTime,
  hospital,
  hospitalName,
  patientRef,
  usePositional,
}) {
  const appointmentDatetime = formatAppointmentDateTime(appointmentDateTime);
  const hospitalAddress = formatHospitalAddress(hospital, hospitalName);
  const ref = patientRef || "—";

  if (usePositional) {
    return templateBodyParameters([
      patientName,
      appointmentDatetime,
      doctorDisplay,
      hospitalAddress,
      ref,
    ]);
  }

  return templateBodyNamedParameters({
    patient_name: patientName,
    appointment_datetime: appointmentDatetime,
    doctor_name: doctorDisplay,
    hospital_address: hospitalAddress,
    patient_id: ref,
  });
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
    "Please arrive 10–15 minutes before your scheduled time. If you need to reschedule, reply here on WhatsApp. For urgent cancellations, contact the hospital.",
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
    "Please use the meeting link at the scheduled time if provided. To reschedule, reply here on WhatsApp.",
    "",
    `— ${facility}`,
  );
  return lines.join("\n");
}

const LOG = "[WhatsApp][AppointmentConfirmation]";

/** Mask a phone for logs: keep last 4 digits only. */
function maskPhoneForLog(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return "(none)";
  return d.length <= 4 ? `****` : `${"*".repeat(d.length - 4)}${d.slice(-4)}`;
}

/**
 * Resolve the phone to message: patient record first, then the caller/session
 * fallback (e.g. the agent call's caller number). Returns the raw value and its
 * source for logging; validation/formatting happens later via normalizeWhatsAppTo.
 * @param {object} appointment
 * @param {string|undefined|null} fallbackPhone
 * @returns {{ phoneRaw: string, source: 'patient_record'|'caller_session'|'none' }}
 */
function resolveAppointmentPhone(appointment, fallbackPhone) {
  const patientPhone =
    appointment?.patient?.phoneNumber != null
      ? String(appointment.patient.phoneNumber).trim()
      : "";
  if (patientPhone) return { phoneRaw: patientPhone, source: "patient_record" };

  const fb = fallbackPhone != null ? String(fallbackPhone).trim() : "";
  if (fb && fb.toLowerCase() !== "unknown") {
    return { phoneRaw: fb, source: "caller_session" };
  }
  return { phoneRaw: "", source: "none" };
}

/**
 * After an appointment is created: if the hospital has WhatsApp Cloud creds, notify the patient.
 * Uses NAMED template `APPOINTMENT_TEMPLATE_NAME` when set; otherwise plain text.
 *
 * Logs every outcome (skip reason or send result) with appointment id, patient id,
 * masked phone + source, and the WhatsApp API response / error details. Throws on a
 * send failure so the caller (queue worker) can retry.
 * @param {object} appointment - lean doc with populated `patient`, `doctor`, optional `hospital`
 * @param {{ fallbackPhone?: string|null }} [opts] - caller/session phone used when the patient record has none
 */
async function notifyAppointmentBooked(appointment, opts = {}) {
  const appointmentId = appointment?.appointmentId || String(appointment?._id || "—");
  const patientId =
    appointment?.patient?._id ? String(appointment.patient._id) : String(appointment?.patient || "—");

  const { phoneRaw, source: phoneSource } = resolveAppointmentPhone(
    appointment,
    opts.fallbackPhone,
  );

  const baseCtx = { appointmentId, patientId, phoneSource, phone: maskPhoneForLog(phoneRaw) };

  if (!phoneRaw) {
    console.warn(`${LOG} SKIP: no patient phone and no caller fallback`, baseCtx);
    return { sent: false, reason: "no_phone" };
  }

  const hospitalId = appointment.hospital?._id || appointment.hospital;
  if (!hospitalId) {
    console.warn(`${LOG} SKIP: no hospital on appointment`, baseCtx);
    return { sent: false, reason: "no_hospital" };
  }

  const [creds, hospital, perm] = await Promise.all([
    WhatsApp.findOne({ hospitalId }).sort({ updatedAt: -1 }).lean(),
    appointment.hospital && typeof appointment.hospital === "object" && appointment.hospital.name
      ? Promise.resolve(appointment.hospital)
      : Hospital.findById(hospitalId)
          .select("name phoneCountryCode address city state pincode")
          .lean(),
    getResolvedHospitalMessagingSettings(hospitalId),
  ]);

  if (!perm.whatsapp.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_disabled", { flow: "appointment_confirmation" });
    console.warn(`${LOG} SKIP: WhatsApp disabled for hospital`, { ...baseCtx, hospitalId: String(hospitalId) });
    return { sent: false, reason: "whatsapp_disabled" };
  }
  if (!perm.whatsapp.appointment) {
    logMessagingPermissionDenied(hospitalId, "whatsapp_appointment", { flow: "appointment_confirmation" });
    console.warn(`${LOG} SKIP: appointment messaging disabled`, { ...baseCtx, hospitalId: String(hospitalId) });
    return { sent: false, reason: "appointment_messaging_disabled" };
  }
  if (appointment.type === "tele-caller" && !perm.teleCaller.isEnabled) {
    logMessagingPermissionDenied(hospitalId, "telecaller_disabled", {
      flow: "appointment_confirmation",
      appointmentType: "tele-caller",
    });
    console.warn(`${LOG} SKIP: tele-caller messaging disabled`, { ...baseCtx, hospitalId: String(hospitalId) });
    return { sent: false, reason: "telecaller_disabled" };
  }

  if (!creds?.phone_number_id || !creds?.access_token) {
    console.warn(`${LOG} SKIP: hospital has no WhatsApp Cloud credentials`, {
      ...baseCtx,
      hospitalId: String(hospitalId),
    });
    return { sent: false, reason: "no_whatsapp_creds" };
  }

  const ccDigits = (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
  const to = normalizeWhatsAppTo(phoneRaw, ccDigits);
  if (!to) {
    console.warn(`${LOG} SKIP: phone failed validation/formatting`, { ...baseCtx, ccDigits });
    return { sent: false, reason: "invalid_phone" };
  }

  const hospitalName = hospital?.name || "Hospital";
  const patientName = appointment.patient?.fullName?.trim() || "Valued patient";
  const doctorDisplay = formatDoctorDisplayName(appointment.doctor?.fullName);
  const patientRef =
    appointment.patient?.patientId?.trim() ||
    appointment.appointmentId ||
    "—";
  const dt = appointment.appointmentDateTime;

  const assignedTemplateName = await getAssignedTemplateName({
    hospitalId,
    phoneNumberId: creds.phone_number_id,
    templateKey: TEMPLATE_KEYS.APPOINTMENT_CONFIRMATION,
  });
  const templateName = assignedTemplateName || env.APPOINTMENT_TEMPLATE_NAME;

  const sendCtx = {
    ...baseCtx,
    to,
    channel:
      appointment.type === "tele-caller"
        ? "text_telecaller"
        : templateName
          ? `template:${templateName}`
          : "text",
  };

  try {
    let apiResponse;

    if (appointment.type === "tele-caller") {
      const textBody = buildTeleCallerAppointmentBookedText(appointment, hospitalName);
      apiResponse = await sendWhatsAppText({
        phoneNumberId: creds.phone_number_id,
        accessToken: creds.access_token,
        to: phoneRaw,
        textBody,
        defaultCountryDigits: ccDigits,
        apiVersion: creds.api_version || undefined,
      });
    } else if (templateName) {
      const usePositional = env.APPOINTMENT_TEMPLATE_PARAM_FORMAT === "positional";
      const components = buildAppointmentTemplateComponents({
        patientName,
        doctorDisplay,
        appointmentDateTime: dt,
        hospital,
        hospitalName,
        patientRef,
        usePositional,
      });
      apiResponse = await sendWhatsAppTemplate({
        phoneNumberId: creds.phone_number_id,
        accessToken: creds.access_token,
        to: phoneRaw,
        templateName,
        languageCode: env.APPOINTMENT_TEMPLATE_LANG,
        components,
        defaultCountryDigits: ccDigits,
        apiVersion: creds.api_version || undefined,
      });
    } else {
      const textBody = buildAppointmentConfirmationText(appointment, hospitalName);
      apiResponse = await sendWhatsAppText({
        phoneNumberId: creds.phone_number_id,
        accessToken: creds.access_token,
        to: phoneRaw,
        textBody,
        defaultCountryDigits: ccDigits,
        apiVersion: creds.api_version || undefined,
      });
    }

    const messageId =
      apiResponse && Array.isArray(apiResponse.messages) && apiResponse.messages[0]
        ? apiResponse.messages[0].id
        : null;
    console.log(`${LOG} SENT`, { ...sendCtx, messageId, apiResponse });
    return { sent: true, messageId };
  } catch (err) {
    console.error(`${LOG} FAILED`, {
      ...sendCtx,
      errorMessage: err && err.message ? err.message : String(err),
      status: err && err.status ? err.status : undefined,
      apiDetail: err && err.apiDetail ? err.apiDetail : undefined,
      // Fully serialized so Meta's nested error_data is never hidden as [Object].
      apiError: err && err.details ? JSON.stringify(err.details) : undefined,
    });
    throw err; // let the queue worker retry
  }
}

/**
 * Load appointment + relations, then send the same notification as API booking (agent / voice flows).
 * WhatsApp row is resolved by `hospital` on the appointment (same hospitalId as the agent uses).
 * @param {string} appointmentId
 * @param {{ fallbackPhone?: string|null }} [opts] - caller/session phone used when the patient record has none
 */
async function notifyAppointmentBookedById(appointmentId, opts = {}) {
  if (!appointmentId) return;

  const populated = await Appointment.findById(appointmentId)
    .populate("doctor", "fullName doctorId designation")
    .populate("patient", "fullName patientId phoneNumber age gender")
    .populate("hospital", "name phoneCountryCode address city state pincode")
    .populate("paymentId", "payment_id order_id amount status paymentDate createdAt")
    .lean();

  if (!populated) {
    console.warn("[WhatsApp] Appointment notify: appointment not found", String(appointmentId));
    return;
  }

  return notifyAppointmentBooked(populated, opts);
}

module.exports = { notifyAppointmentBooked, notifyAppointmentBookedById };
