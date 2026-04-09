const mongoose = require("mongoose");
const Appointment = require("../models/appointment.model");
const Doctor = require("../models/doctor.model");
const Patient = require("../models/patient.model");
const { generateAppointmentId } = require("../utils/appointmentId");
const { getRazorpayInstance } = require("../razorpay/client");
const { createMeetLink } = require("./googleMeet.service");
const { enrichPaymentHistoryBookingContext } = require("./paymentHistory.service");

function mergeNotesFromEntities(paymentEntity, orderEntity) {
  const out = {};
  if (paymentEntity?.notes && typeof paymentEntity.notes === "object") {
    Object.assign(out, paymentEntity.notes);
  }
  if (orderEntity?.notes && typeof orderEntity.notes === "object") {
    Object.assign(out, orderEntity.notes);
  }
  return out;
}

function shouldBookFromNotes(notes) {
  if (!notes || typeof notes !== "object") return false;
  const v = notes.bookVideoAppointment;
  return v === true || v === "true" || v === "1" || v === "yes";
}

/** First non-empty trimmed value among note keys (handles frontend typos / snake_case). */
function firstTrimmedNote(notes, keys) {
  for (const key of keys) {
    const v = notes[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

/**
 * Stringify note fields for Mongo / validation (webhook JSON may use booleans).
 * Accepts `docotrEmail` → doctorEmail, `pateintEmail` → patientEmail, plus snake_case.
 */
function normalizeBookingNotes(notes) {
  const n = { ...notes };
  const patientEmail = firstTrimmedNote(n, [
    "patientEmail",
    "pateintEmail",
    "patient_email",
  ]);
  const doctorEmail = firstTrimmedNote(n, [
    "doctorEmail",
    "docotrEmail",
    "doctor_email",
  ]);
  if (patientEmail) n.patientEmail = patientEmail;
  if (doctorEmail) n.doctorEmail = doctorEmail;

  for (const key of [
    "patient",
    "doctor",
    "reason",
    "hospitalId",
    "patientEmail",
    "doctorEmail",
  ]) {
    if (n[key] != null) n[key] = String(n[key]).trim();
  }
  if (n.appointmentDateTime != null) {
    n.appointmentDateTime = String(n.appointmentDateTime).trim();
  }
  return n;
}

/**
 * Interprets the booking datetime as **India (IST, UTC+5:30) wall-clock**, then returns the stored UTC `Date`.
 * Trailing `Z` is stripped so values like `2026-04-09T05:00:00.000Z` mean **05:00 on that date in IST**, not UTC.
 * If the string already includes a non-Z timezone offset, it is parsed as-is.
 */
function parseAppointmentDateTimeAsIST(raw) {
  if (raw instanceof Date) return raw;
  if (raw == null) return new Date(NaN);
  const s = String(raw).trim();
  if (!s) return new Date(NaN);

  // Explicit offset (e.g. +05:30, +0530, -04:00) — use instant as given
  if (/[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    return new Date(s);
  }

  const withoutZ = s.replace(/Z$/i, "");
  const isoLocal = withoutZ.includes("T") ? withoutZ : `${withoutZ}T00:00:00`;
  return new Date(`${isoLocal}+05:30`);
}

/**
 * On `payment.captured` webhook: if order/payment notes request a video booking, create appointment.
 * Notes must use **string** values (Razorpay limit). Keys: bookVideoAppointment, patient, doctor,
 * reason, appointmentDateTime; optional: hospitalId. Meet link is always created via Google Calendar (not notes).
 *
 * @param {object|null} paymentHistoryLean - row from PaymentHistory after webhook upsert (same capture).
 * @returns {Promise<object|null>} populated appointment, or null if no booking requested
 */
async function tryBookVideoCallOnPaymentCaptured(payload, paymentHistoryLean) {
  const pay = payload?.payload?.payment?.entity;
  if (!pay || !pay.id) return null;

  const orderEnt = payload?.payload?.order?.entity;
  let notes = mergeNotesFromEntities(pay, orderEnt);

  if (!shouldBookFromNotes(notes) && pay.order_id) {
    const rz = getRazorpayInstance();
    if (rz) {
      try {
        const order = await rz.orders.fetch(pay.order_id);
        notes = { ...notes, ...(order.notes || {}) };
      } catch (e) {
        console.error("[Razorpay] orders.fetch for booking notes:", e.message);
      }
    }
  }

  if (!shouldBookFromNotes(notes)) return null;

  notes = normalizeBookingNotes(notes);

  const dt = parseAppointmentDateTimeAsIST(notes.appointmentDateTime);
  if (Number.isNaN(dt.getTime())) {
    console.error(
      "[Razorpay booking] Invalid appointmentDateTime (IST parse):",
      notes.appointmentDateTime,
    );
    return null;
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(
      "[Razorpay booking] payment.captured — IST slot → UTC stored:",
      notes.appointmentDateTime,
      "→",
      dt.toISOString(),
    );
  }

  const body = {
    patient: notes.patient,
    doctor: notes.doctor,
    reason: notes.reason,
    appointmentDateTime: dt,
    hospitalId: notes.hospitalId,
    patientEmail: notes.patientEmail,
    doctorEmail: notes.doctorEmail,
    razorpayPaymentId: pay.id,
    paymentId: paymentHistoryLean?._id,
  };

  return createVideoCallAppointmentAfterPayment(body);
}

/**
 * Create a video-call appointment after payment is confirmed (capture path).
 * Sets `type` to `tele-caller` (Razorpay webhook bookings). Pass `razorpayPaymentId` for idempotency (webhook retries).
 *
 * @param {object} body - patient, doctor, reason, appointmentDateTime, patientEmail, doctorEmail; optional hospitalId, razorpayPaymentId, paymentId
 * @returns {Promise<object>} populated appointment lean doc
 */
async function createVideoCallAppointmentAfterPayment(body) {
  const payRef = body.razorpayPaymentId || body.razorpay_payment_id;
  if (payRef) {
    const existing = await Appointment.findOne({
      razorpayPaymentId: String(payRef).trim(),
    })
      .populate("doctor", "fullName doctorId designation")
      .populate("patient", "fullName patientId phoneNumber age gender")
      .populate("hospital", "name phoneCountryCode")
      .populate("paymentId", "payment_id order_id amount status paymentDate createdAt")
      .lean();
    if (existing) return existing;
  }

  const patientId = body.patient;
  const doctorId = body.doctor;
  const reason = body.reason;
  const appointmentDateTime = body.appointmentDateTime;
  const hospitalIdRaw = body.hospitalId;
  const patientEmail = body.patientEmail;
  const doctorEmail = body.doctorEmail;
  const paymentIdRaw = body.paymentId;

  if (
    !patientId ||
    !doctorId ||
    reason == null ||
    String(reason).trim() === "" ||
    !appointmentDateTime
  ) {
    const err = new Error(
      "Video booking requires patient, doctor, reason, and appointmentDateTime (from order notes or request body)",
    );
    err.statusCode = 400;
    throw err;
  }

  if (
    !mongoose.isValidObjectId(patientId) ||
    !mongoose.isValidObjectId(doctorId)
  ) {
    const err = new Error("Invalid patient or doctor id");
    err.statusCode = 400;
    throw err;
  }

  const dt =
    appointmentDateTime instanceof Date
      ? appointmentDateTime
      : new Date(appointmentDateTime);
  if (Number.isNaN(dt.getTime())) {
    const err = new Error("appointmentDateTime must be a valid ISO 8601 date");
    err.statusCode = 400;
    throw err;
  }

  const [doctorExists, patientExists] = await Promise.all([
    Doctor.findById(doctorId).lean(),
    Patient.findById(patientId).lean(),
  ]);

  if (!doctorExists) {
    const err = new Error("Doctor not found");
    err.statusCode = 404;
    throw err;
  }
  if (!patientExists) {
    const err = new Error("Patient not found");
    err.statusCode = 404;
    throw err;
  }

  if (
    doctorExists.hospital &&
    patientExists.hospital &&
    !doctorExists.hospital.equals(patientExists.hospital)
  ) {
    const err = new Error(
      "Doctor and patient must belong to the same hospital",
    );
    err.statusCode = 400;
    throw err;
  }

  let hospitalId =
    (hospitalIdRaw && mongoose.isValidObjectId(String(hospitalIdRaw))
      ? String(hospitalIdRaw)
      : null) ||
    (doctorExists.hospital ? String(doctorExists.hospital) : null) ||
    (patientExists.hospital ? String(patientExists.hospital) : null);

  if (!hospitalId) {
    const err = new Error(
      "Hospital could not be determined; link patient and doctor to a hospital or pass hospitalId",
    );
    err.statusCode = 400;
    throw err;
  }

  if (doctorExists.hospital && String(doctorExists.hospital) !== hospitalId) {
    const err = new Error("Doctor does not belong to the resolved hospital");
    err.statusCode = 400;
    throw err;
  }
  if (patientExists.hospital && String(patientExists.hospital) !== hospitalId) {
    const err = new Error("Patient does not belong to the resolved hospital");
    err.statusCode = 400;
    throw err;
  }

  if (paymentIdRaw && mongoose.isValidObjectId(String(paymentIdRaw))) {
    await enrichPaymentHistoryBookingContext(paymentIdRaw, {
      hospitalId,
      patientId,
      doctorId,
    });
  }

  const appointmentId = await generateAppointmentId();

  const patientAttendeeEmail =
    patientEmail != null && String(patientEmail).trim() !== ""
      ? String(patientEmail).trim()
      : null;
  const doctorAttendeeEmail =
    doctorEmail != null && String(doctorEmail).trim() !== ""
      ? String(doctorEmail).trim()
      : null;

  if (!patientAttendeeEmail || !doctorAttendeeEmail) {
    const err = new Error(
      "Tele-caller booking requires patient and doctor emails in Razorpay order/payment notes: patientEmail (or patient_email) and doctorEmail (or docotrEmail typo / doctor_email). Google Meet is created server-side; notes videoUrl is not used.",
    );
    err.statusCode = 400;
    throw err;
  }

  const endDateTime = new Date(dt.getTime() + 30 * 60 * 1000);
  const doctorName = doctorExists.fullName || "Doctor";
  const patientName = patientExists.fullName || "Patient";
  const resolvedVideoUrl = await createMeetLink({
    attendeeEmails: [patientAttendeeEmail, doctorAttendeeEmail],
    startTime: dt.toISOString(),
    endTime: endDateTime.toISOString(),
    summary: `Consultation: ${patientName} with ${doctorName}`,
    description: `Paid video consultation appointment ${appointmentId}`,
  });

  const doc = {
    patient: patientId,
    doctor: doctorId,
    reason: String(reason).trim(),
    appointmentDateTime: dt,
    type: "tele-caller",
    status: "Upcoming",
    hospital: new mongoose.Types.ObjectId(hospitalId),
    appointmentId,
  };

  doc.videoUrl = resolvedVideoUrl;

  if (payRef) {
    doc.razorpayPaymentId = String(payRef).trim();
  }

  if (paymentIdRaw && mongoose.isValidObjectId(String(paymentIdRaw))) {
    doc.paymentId = new mongoose.Types.ObjectId(String(paymentIdRaw));
  }

  const appointment = await Appointment.create(doc);
  const populated = await Appointment.findById(appointment._id)
    .populate("doctor", "fullName doctorId designation")
    .populate("patient", "fullName patientId phoneNumber age gender")
    .populate("hospital", "name phoneCountryCode")
    .populate("paymentId", "payment_id order_id amount status paymentDate createdAt")
    .lean();

  return populated;
}

module.exports = {
  createVideoCallAppointmentAfterPayment,
  tryBookVideoCallOnPaymentCaptured,
  parseAppointmentDateTimeAsIST,
};
