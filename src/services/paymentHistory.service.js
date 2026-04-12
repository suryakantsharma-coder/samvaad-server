const mongoose = require("mongoose");
const PaymentHistory = require("../models/paymentHistory.model");

function mergeNotesFromPaymentPayload(payload) {
  const out = {};
  const pay = payload?.payload?.payment?.entity;
  const orderEnt = payload?.payload?.order?.entity;
  if (pay?.notes && typeof pay.notes === "object") {
    Object.assign(out, pay.notes);
  }
  if (orderEnt?.notes && typeof orderEnt.notes === "object") {
    Object.assign(out, orderEnt.notes);
  }
  return out;
}

function optionalObjectIdFromNotes(notes, key) {
  if (!notes || typeof notes !== "object") return undefined;
  const raw = notes[key];
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s || !mongoose.isValidObjectId(s)) return undefined;
  return new mongoose.Types.ObjectId(s);
}

/** Resolve appointment ref from Razorpay note keys (camelCase / snake_case). */
function optionalAppointmentIdFromNotes(notes) {
  if (!notes || typeof notes !== "object") return undefined;
  for (const key of ["appointment", "appointmentId", "appointment_id"]) {
    const id = optionalObjectIdFromNotes(notes, key);
    if (id) return id;
  }
  return undefined;
}

/**
 * Persist payment row from verified Razorpay webhook (payment.captured | payment.failed | payment.authorized).
 * Idempotent on payment_id (upsert). Enriches from payment/order notes when present.
 * @returns {Promise<object|null>} saved lean doc, or null if event not handled / no entity
 */
async function upsertFromRazorpayWebhook(webhookEvent, payload) {
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

  let status;
  if (webhookEvent === "payment.captured") status = "captured";
  else if (webhookEvent === "payment.failed") status = "failed";
  else status = "pending";

  const createdAt = entity.created_at
    ? new Date(entity.created_at * 1000)
    : new Date();

  const paymentDate =
    status === "captured" && entity.captured_at
      ? new Date(entity.captured_at * 1000)
      : createdAt;

  const amount =
    typeof entity.amount === "number" && Number.isFinite(entity.amount)
      ? entity.amount
      : 0;

  const notes = mergeNotesFromPaymentPayload(payload);
  const hospital = optionalObjectIdFromNotes(notes, "hospitalId");
  const patient = optionalObjectIdFromNotes(notes, "patient");
  const doctor = optionalObjectIdFromNotes(notes, "doctor");

  const setDoc = {
    payment_id: entity.id,
    order_id: entity.order_id ? String(entity.order_id) : "",
    amount,
    status,
    createdAt,
    paymentDate,
  };

  if (hospital) setDoc.hospital = hospital;
  if (patient) setDoc.patient = patient;
  if (doctor) setDoc.doctor = doctor;

  const doc = await PaymentHistory.findOneAndUpdate(
    { payment_id: entity.id },
    { $set: setDoc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return doc;
}

/**
 * After booking resolves doctor/patient/hospital, ensure PaymentHistory row is linked.
 */
async function enrichPaymentHistoryBookingContext(paymentHistoryId, { hospitalId, patientId, doctorId }) {
  if (!paymentHistoryId || !mongoose.isValidObjectId(String(paymentHistoryId))) {
    return null;
  }
  const update = {};
  if (hospitalId && mongoose.isValidObjectId(String(hospitalId))) {
    update.hospital = new mongoose.Types.ObjectId(String(hospitalId));
  }
  if (patientId && mongoose.isValidObjectId(String(patientId))) {
    update.patient = new mongoose.Types.ObjectId(String(patientId));
  }
  if (doctorId && mongoose.isValidObjectId(String(doctorId))) {
    update.doctor = new mongoose.Types.ObjectId(String(doctorId));
  }
  if (Object.keys(update).length === 0) return null;

  return PaymentHistory.findByIdAndUpdate(
    paymentHistoryId,
    { $set: update },
    { new: true },
  ).lean();
}

module.exports = {
  upsertFromRazorpayWebhook,
  enrichPaymentHistoryBookingContext,
  mergeNotesFromPaymentPayload,
  optionalObjectIdFromNotes,
  optionalAppointmentIdFromNotes,
};
