const mongoose = require("mongoose");
// Reuse existing Mongoose models used by the agent
// Hospital slot validators (used when confirming appointments from voice/AI flows).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AppointmentModel = require("../../src/models/appointment.model");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PatientModel = require("../../src/models/patient.model");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notifyAppointmentBookedById } = require("../../src/services/appointmentWhatsAppNotify");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseAppointmentDateTimeAsIST,
} = require("../../src/utils/appointmentDateTimeIST");
const {
  normalizePatientFieldsForStorage,
  normalizeReasonForStorage,
} = require("../../src/utils/storageEnglishNormalize");

async function createPatient({
  hospitalId,
  fullName,
  age,
  gender,
  phoneNumber,
  reason,
}) {
  const year = new Date().getFullYear();
  const prefix = `P-${year}-`;
  const last = await PatientModel.findOne({
    patientId: new RegExp(`^${prefix}`),
  })
    .sort({ patientId: -1 })
    .select("patientId")
    .lean();

  const nextNum = last
    ? parseInt(String(last.patientId).slice(prefix.length), 10) + 1
    : 1;
  const patientId = `${prefix}${String(nextNum).padStart(6, "0")}`;

  const {
    fullName: fullNameDb,
    reason: reasonDb,
    gender: genderDb,
  } = await normalizePatientFieldsForStorage({
    fullName,
    reason,
    gender,
  });

  const doc = await PatientModel.create({
    hospital: new mongoose.Types.ObjectId(hospitalId),
    patientId,
    fullName: fullNameDb,
    age,
    gender: genderDb,
    phoneNumber,
    reason: reasonDb,
  });

  return doc;
}

async function createAppointment({
  hospitalId,
  patientObjectId,
  doctorObjectId,
  reason,
  appointmentDateTimeISO,
  type = "call",
}) {
  const year = new Date().getFullYear();
  const prefix = `A-${year}-`;
  const last = await AppointmentModel.findOne({
    appointmentId: new RegExp(`^${prefix}`),
  })
    .sort({ appointmentId: -1 })
    .select("appointmentId")
    .lean();

  const nextNum = last
    ? parseInt(String(last.appointmentId).slice(prefix.length), 10) + 1
    : 1;
  const appointmentId = `${prefix}${String(nextNum).padStart(6, "0")}`;

  const parsedDt = appointmentDateTimeISO
    ? parseAppointmentDateTimeAsIST(appointmentDateTimeISO)
    : null;
  const dt =
    parsedDt && !Number.isNaN(parsedDt.getTime()) ? parsedDt : null;

  const reasonDb = await normalizeReasonForStorage(reason);

  const doc = await AppointmentModel.create({
    hospital: new mongoose.Types.ObjectId(hospitalId),
    appointmentId,
    patient: new mongoose.Types.ObjectId(patientObjectId),
    doctor: new mongoose.Types.ObjectId(doctorObjectId),
    reason: reasonDb,
    status: "Upcoming",
    type,
    appointmentDateTime: dt,
  });

  return doc;
}

/**
 * Apply backend side‑effects for an extracted appointment decision.
 * This is where we actually create patients/appointments AFTER the call ends.
 */
async function processAppointmentExtraction(hospitalId, result) {
  if (!result || typeof result !== "object") {
    // eslint-disable-next-line no-console
    console.warn(
      "[processAppointmentExtraction] Invalid result payload, skipping.",
    );
    return;
  }

  // Basic guard: never create anything if action is "no_appointment"
  if (result.action === "no_appointment") {
    // eslint-disable-next-line no-console
    console.log("[processAppointmentExtraction] No appointment action:", {
      hospitalId,
      notes: result.notes,
    });
    return;
  }

  if (result.action === "create_appointment_for_existing_patient") {
    if (!result.existingPatientObjectId || !result.doctorObjectId) {
      // eslint-disable-next-line no-console
      console.warn(
        "[processAppointmentExtraction] Missing patient/doctor for existing-patient flow, skipping.",
      );
      return;
    }

    const apptDoc = await createAppointment({
      hospitalId,
      patientObjectId: result.existingPatientObjectId,
      doctorObjectId: result.doctorObjectId,
      reason: result.reason || "",
      appointmentDateTimeISO: result.appointmentDateTimeISO,
      type: "call",
    });

    notifyAppointmentBookedById(apptDoc._id).catch((err) =>
      // eslint-disable-next-line no-console
      console.error("[WhatsApp] agent appointment notify:", err.message, err.details || ""),
    );

    // eslint-disable-next-line no-console
    console.log(
      "[processAppointmentExtraction] Created appointment for existing patient",
      {
        hospitalId,
        patientObjectId: result.existingPatientObjectId,
        doctorObjectId: result.doctorObjectId,
      },
    );
    return;
  }

  if (result.action === "create_new_patient_and_appointment") {
    if (!result.newPatientFullName || !result.doctorObjectId) {
      // eslint-disable-next-line no-console
      console.warn(
        "[processAppointmentExtraction] Missing new patient name/doctor, skipping.",
      );
      return;
    }

    const gender =
      result.newPatientGender === "Male" ||
      result.newPatientGender === "Female" ||
      result.newPatientGender === "Other"
        ? result.newPatientGender
        : "Other";

    const patient = await createPatient({
      hospitalId,
      fullName: result.newPatientFullName,
      age: result.newPatientAge ?? null,
      gender,
      phoneNumber: result.phoneNumber ?? null,
      reason: result.reason || "",
    });

    const apptDoc = await createAppointment({
      hospitalId,
      patientObjectId: String(patient._id),
      doctorObjectId: result.doctorObjectId,
      reason: result.reason || "",
      appointmentDateTimeISO: result.appointmentDateTimeISO,
      type: "call",
    });

    notifyAppointmentBookedById(apptDoc._id).catch((err) =>
      // eslint-disable-next-line no-console
      console.error("[WhatsApp] agent appointment notify:", err.message, err.details || ""),
    );

    // eslint-disable-next-line no-console
    console.log(
      "[processAppointmentExtraction] Created new patient + appointment",
      {
        hospitalId,
        patientObjectId: String(patient._id),
        doctorObjectId: result.doctorObjectId,
      },
    );
    return;
  }

  // Fallback safety: log unexpected action
  // eslint-disable-next-line no-console
  console.warn(
    "[processAppointmentExtraction] Unhandled action, no side-effects applied:",
    result.action,
  );
}

module.exports = {
  processAppointmentExtraction,
};

