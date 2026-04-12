const mongoose = require("mongoose");
const PaymentTransaction = require("../models/paymentTransaction.model");
const Patient = require("../models/patient.model");
const Hospital = require("../models/hospital.model");
const Appointment = require("../models/appointment.model");
const {
  mergeNotesFromPaymentPayload,
  optionalObjectIdFromNotes,
  optionalAppointmentIdFromNotes,
} = require("./paymentHistory.service");

function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Upsert PaymentTransaction from a verified Razorpay webhook (`payment.captured` | `payment.failed` | `payment.authorized`).
 * Idempotent on `razorpayPaymentId`. Does not overwrite tele-caller signature / recordedBy when row already exists from API.
 *
 * @returns {Promise<object|null>} lean doc or null
 */
async function upsertPaymentTransactionFromWebhook(webhookEvent, payload) {
  if (
    webhookEvent !== "payment.captured" &&
    webhookEvent !== "payment.failed" &&
    webhookEvent !== "payment.authorized"
  ) {
    return null;
  }

  const entity = payload?.payload?.payment?.entity;
  if (!entity || !entity.id) {
    return null;
  }

  const notes = mergeNotesFromPaymentPayload(payload);
  const patient = optionalObjectIdFromNotes(notes, "patient");
  const hospital = optionalObjectIdFromNotes(notes, "hospitalId");
  const appointment = optionalAppointmentIdFromNotes(notes);

  const amount =
    typeof entity.amount === "number" && Number.isFinite(entity.amount) ? entity.amount : 0;
  const currency = entity.currency ? String(entity.currency).trim() : "INR";
  const razorpayCreatedAt = entity.created_at
    ? new Date(entity.created_at * 1000)
    : new Date();

  let razorpayStatus = entity.status ? String(entity.status).trim() : "";
  if (!razorpayStatus) {
    if (webhookEvent === "payment.captured") razorpayStatus = "captured";
    else if (webhookEvent === "payment.failed") razorpayStatus = "failed";
    else razorpayStatus = "authorized";
  }

  const errParts = [];
  if (entity.error_code) errParts.push(String(entity.error_code));
  if (entity.error_description) errParts.push(String(entity.error_description));
  const errorNote = errParts.length ? errParts.join(" — ").slice(0, 2000) : "";

  const existing = await PaymentTransaction.findOne({
    razorpayPaymentId: entity.id,
  }).lean();

  const isTeleCallerRecord =
    existing &&
    (existing.recordedVia === "tele_caller_api" ||
      (existing.razorpaySignature && String(existing.razorpaySignature).trim().length > 0));

  const setDoc = {
    razorpayOrderId: entity.order_id ? String(entity.order_id) : "",
    amount,
    currency,
    razorpayStatus,
    paymentMethod: entity.method ? String(entity.method) : undefined,
    razorpayCreatedAt,
  };

  if (patient) setDoc.patient = patient;
  if (hospital) setDoc.hospital = hospital;
  if (appointment) setDoc.appointment = appointment;

  if (isTeleCallerRecord) {
    // Keep client-recorded audit fields; refresh gateway fields only.
  } else {
    setDoc.recordedVia = "razorpay_webhook";
    if (!existing || !existing.razorpaySignature) {
      setDoc.razorpaySignature = "";
    }
    setDoc.signatureVerified = false;
  }

  if (webhookEvent === "payment.failed" && errorNote) {
    setDoc.internalNotes = errorNote;
  }

  const shouldFillSnapshots =
    !existing ||
    !existing.patientNameSnapshot ||
    !existing.hospitalNameSnapshot ||
    (appointment && !existing.appointmentIdDisplaySnapshot);

  if (shouldFillSnapshots) {
    if (patient) {
      const p = await Patient.findById(patient).select("fullName phoneNumber").lean();
      if (p) {
        setDoc.patientNameSnapshot = p.fullName || "";
        setDoc.patientPhoneSnapshot = p.phoneNumber || "";
      }
    }
    if (hospital) {
      const h = await Hospital.findById(hospital).select("name").lean();
      if (h) setDoc.hospitalNameSnapshot = h.name || "";
    }
    if (appointment) {
      const a = await Appointment.findById(appointment).select("appointmentId").lean();
      if (a) setDoc.appointmentIdDisplaySnapshot = a.appointmentId || String(appointment);
    }
  }

  const update = { $set: pruneUndefined(setDoc) };

  const doc = await PaymentTransaction.findOneAndUpdate(
    { razorpayPaymentId: entity.id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return doc;
}

module.exports = {
  upsertPaymentTransactionFromWebhook,
};
