/**
 * OpenAI Realtime API tool definitions for the voice agent.
 */

function getRealtimeTools() {
  return [
    {
      type: "function",
      name: "fetch_patient_by_patientId",
      description:
        "Find the patient using patientId (e.g. P-2026-000001) for the current hospital. Lookup is by patientId only. Returns the patient record including _id; use that _id as patientObjectId when calling create_appointment.",
      parameters: {
        type: "object",
        properties: {
          patientId: {
            type: "string",
            description: "Patient ID like P-2026-000001",
          },
        },
        required: ["patientId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "fetch_patient_by_phone",
      description:
        "Find the patient by registered mobile number (10 digits) for the current hospital. Use when the caller says they are an existing patient and provides their phone number. Returns the patient record including _id; use that _id as patientObjectId when calling create_appointment.",
      parameters: {
        type: "object",
        properties: {
          phoneNumber: {
            type: "string",
            description:
              "10-digit mobile number as string, e.g. 9876543210 or 8383801256",
          },
        },
        required: ["phoneNumber"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "create_patient",
      description:
        "Create a new patient for the current hospital and return **patientId** (human-readable, e.g. P-2026-000001) plus **patient._id** (MongoDB ObjectId string, 24 hex characters). **You MUST pass `patient._id` from this response as `patientObjectId` in `create_appointment`** — not patientId, not age, not a guess. The caller's phone number from the call is automatically used for phoneNumber when not provided. The agent asks **age and gender in one combined question** after the name. For age: always pass an **integer** (years) — the caller may say the age in Hindi or Gujarati; convert words like चौबीस→24, पचीस→25 to a number, never a string. For gender: use Male/Female/Other from that reply (or a short follow-up if they only answered one part). **reason is mandatory:** pass the visit reason in English from section 1 of this call (same value you will use in create_appointment), even if the caller said it earlier in Hindi or Gujarati — never omit reason.",
      parameters: {
        type: "object",
        properties: {
          fullName: { type: "string" },
          age: {
            type: "number",
            description:
              "Age in years as an integer, e.g. 24. Convert Hindi/Gujarati words (चौबीस→24), Devanagari numerals (२४→24), digit-by-digit Hindi ('दो चार'→24), or English digits. If ambiguous in transcript, confirm with caller before calling this tool.",
          },
          gender: {
            type: "string",
            enum: ["Male", "Female", "Other"],
            description:
              "Male, Female, or Other. The agent asks age+gender together using the English words male, female, other in the same question — use the caller’s answer here.",
          },
          phoneNumber: {
            type: "string",
            description:
              "Optional. If omitted or 'not provided', the system uses the phone number Exotel received the call from.",
          },
          reason: {
            type: "string",
            description:
              "Required. Symptom/illness in English from the visit reason collected in this call (section 1). If the caller said it in Hindi or Gujarati earlier, convert to English here (e.g. दांत में दर्द → tooth pain). Use the same reason on create_appointment.",
          },
        },
        required: ["fullName", "age", "gender", "reason"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_doctors",
      description:
        "List ALL doctors for the current hospital. Returns every doctor with _id, fullName, designation (e.g. Cardiologist, Dermatologist), availability, status. You MUST select the doctor whose medical specialty (designation) best matches the caller's visit reason or symptoms (e.g. heart issues -> cardiology, skin -> dermatology) — not an arbitrary name. Use that doctor's _id as doctorObjectId. Use their availability (hours/days) so the appointment time fits before final confirmation; adjust with the caller if needed.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "search_doctors",
      description:
        "Search doctors by name or designation within the current hospital (optional filter). Returns matching doctors with _id, fullName, designation, availability, status. To get the full list first, use list_doctors instead. Use the selected doctor's _id as doctorObjectId when calling create_appointment. Respect availability when proposing appointment time (see voice instructions section 6b).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "create_appointment",
      description:
        "Create or update an appointment linking patient and doctor by their database **MongoDB _id** values only. **Order for a new patient:** (1) Call **create_patient** and wait for ok:true; (2) call **create_appointment** with **patientObjectId = that tool's `patient._id`** (24 hex), **never** before step 1 succeeds. For an existing patient, call **fetch_patient_by_patientId** or **fetch_patient_by_phone** first, then use returned `patient._id` as patientObjectId. reason must be the illness/symptom the caller stated during this call, in English. If the caller said an English disease name (e.g. piles, diabetes, BP, fever), use that exact word; otherwise use the English equivalent of what they said. **Same phone call — corrections:** If an appointment was **already booked successfully earlier in this same call** and the caller wants to change doctor, date, time, or reason, call this tool again with the **new** fields; the server will **update that same appointment** (same appointment number) instead of creating a second one. The voice session may inject existingAppointmentObjectId after the first success. Before calling this tool, the assistant must say a short wait line in the caller's locked language (Hindi or Gujarati; feminine tone as Neha), then call this function. On success (ok: true) the appointment is booked or updated — read messageHindi or messageGujarati once as booking status only; never tell the caller booking failed when ok is true. On failure: messageHindi, messageGujarati, code — always address the caller in their chosen language, never read raw English to them.",
      parameters: {
        type: "object",
        properties: {
          doctorObjectId: {
            type: "string",
            description:
              "The doctor's _id from list_doctors result (MongoDB ObjectId)",
          },
          patientObjectId: {
            type: "string",
            description:
              "**Required.** MongoDB ObjectId string (24 hex characters) from **create_patient** response field `patient._id`, OR from **fetch_patient_by_patientId** / **fetch_patient_by_phone** result `patient._id`. **Never** use human patientId (P-2026-…), caller age, or placeholders like \"1\" — only the `_id` from a successful patient tool call.",
          },
          reason: {
            type: "string",
            description:
              "The illness/symptom in English, exactly as the caller said or its English equivalent (e.g. piles, diabetes, BP). Preserve English disease names as-is. Use only what was said in this call, not the patient's old reason.",
          },
          appointmentDateTimeISO: {
            type: "string",
            description:
              "Appointment date+time as ISO with India offset +05:30 (IST wall clock), e.g. 2026-04-25T15:30:00+05:30. The caller may say date/time in Hindi or Gujarati (month names, आज/कल, साढ़े तीन, etc.) — convert to this format. Prefer +05:30; trailing Z is interpreted as IST wall time by the server, not UTC.",
          },
          type: { type: "string", default: "call" },
          existingAppointmentObjectId: {
            type: "string",
            description:
              "Optional. MongoDB _id of an appointment already booked in this same call, to update instead of creating a new appointment. The voice stack usually fills this automatically after the first successful booking; omit unless you must override.",
          },
        },
        required: [
          "doctorObjectId",
          "patientObjectId",
          "reason",
          "appointmentDateTimeISO",
        ],
        additionalProperties: false,
      },
    },
  ];
}

module.exports = { getRealtimeTools };
