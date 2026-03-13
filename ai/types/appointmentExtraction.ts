export type TranscriptRole = "user" | "assistant";

export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
}

export interface ExistingPatientRef {
  patientId: string; // business-facing patient id, e.g. "P-2026-000013"
  patientObjectId: string; // Mongo ObjectId as string
  fullName: string;
  phoneNumber: string;
}

export interface ExistingDoctorRef {
  doctorId: string; // optional business id; may be empty string
  doctorObjectId: string; // Mongo ObjectId as string
  fullName: string;
  designation: string; // e.g. "Cardiologist", "Dermatologist"
}

export interface AppointmentExtractionInput {
  hospitalId: string;
  hospitalName: string;
  callerPhone: string | null; // normalized 10-digit if possible
  transcript: TranscriptTurn[];
  existingPatientsByPhone: ExistingPatientRef[];
  doctorsForHospital: ExistingDoctorRef[];
}

export type AppointmentAction =
  | "create_appointment_for_existing_patient"
  | "create_new_patient_and_appointment"
  | "no_appointment";

export type PatientStatus = "existing" | "new" | "unknown";

export type NewPatientGender = "Male" | "Female" | "Other" | "Unknown";

export interface AppointmentExtractionOutput {
  // Whether the caller appears to be an existing or new patient
  patientStatus: PatientStatus;

  // For existing patient flow (if confidently resolved)
  existingPatientObjectId: string;
  existingPatientId: string;

  // For new patient flow
  newPatientFullName: string;
  newPatientAge: number | null;
  newPatientGender: NewPatientGender;

  // Phone number to use for patient records (usually callerPhone)
  phoneNumber: string | null;

  // Selected doctor to book with
  doctorObjectId: string;
  doctorName: string;

  // Reason / symptoms in English
  reason: string;

  // What the patient said about date/time (free-form)
  preferredDateText: string | null;
  preferredTimeText: string | null;

  // Parsed ISO datetime in UTC, or null if not confidently determined
  appointmentDateTimeISO: string | null;

  // What backend should do with this result
  action: AppointmentAction;

  // English notes for logging / debugging
  notes: string;
}

