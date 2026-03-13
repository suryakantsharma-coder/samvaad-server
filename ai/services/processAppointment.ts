import mongoose from "mongoose";
import type { AppointmentExtractionOutput } from "../types/appointmentExtraction";

// Reuse existing Mongoose models used by the agent
// Adjust import paths if your models live elsewhere.
// These mirror the imports in src/agent/index.js.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AppointmentModel = require("../../src/models/appointment.model");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PatientModel = require("../../src/models/patient.model");

interface CreateAppointmentArgs {
  hospitalId: string;
  patientObjectId: string;
  doctorObjectId: string;
  reason: string;
  appointmentDateTimeISO: string | null;
  type?: string;
}

interface CreatePatientArgs {
  hospitalId: string;
  fullName: string;
  age: number | null;
  gender: string;
  phoneNumber: string | null;
  reason: string;
}

async function createPatient({
  hospitalId,
  fullName,
  age,
  gender,
  phoneNumber,
  reason,
}: CreatePatientArgs): Promise<mongoose.Document> {
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

  const doc = await PatientModel.create({
    hospital: new mongoose.Types.ObjectId(hospitalId),
    patientId,
    fullName,
    age,
    gender,
    phoneNumber,
    reason,
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
}: CreateAppointmentArgs): Promise<mongoose.Document> {
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

  const dt =
    appointmentDateTimeISO && !Number.isNaN(new Date(appointmentDateTimeISO).getTime())
      ? new Date(appointmentDateTimeISO)
      : null;

  const doc = await AppointmentModel.create({
    hospital: new mongoose.Types.ObjectId(hospitalId),
    appointmentId,
    patient: new mongoose.Types.ObjectId(patientObjectId),
    doctor: new mongoose.Types.ObjectId(doctorObjectId),
    reason,
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
export async function processAppointmentExtraction(
  hospitalId: string,
  result: AppointmentExtractionOutput,
): Promise<void> {
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

    await createAppointment({
      hospitalId,
      patientObjectId: result.existingPatientObjectId,
      doctorObjectId: result.doctorObjectId,
      reason: result.reason || "",
      appointmentDateTimeISO: result.appointmentDateTimeISO,
      type: "call",
    });

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

    await createAppointment({
      hospitalId,
      patientObjectId: String(patient._id),
      doctorObjectId: result.doctorObjectId,
      reason: result.reason || "",
      appointmentDateTimeISO: result.appointmentDateTimeISO,
      type: "call",
    });

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

