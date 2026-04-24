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
        "Create a new patient for the current hospital and return patientId + details including _id. The caller's phone number from the call is automatically used for phoneNumber when not provided. Use the returned _id when linking to an appointment via create_appointment. For age: always pass an **integer** (years) — the caller may say the age in Hindi or Gujarati; convert words like चौबीस→24, पचीस→25 to a number, never a string. For gender: use Male/Female/Other after you confirmed with the caller (including after inferring from name and they said yes).",
      parameters: {
        type: "object",
        properties: {
          fullName: { type: "string" },
          age: {
            type: "number",
            description:
              "Age in years as an integer, e.g. 24. Convert from spoken Hindi/Gujarati if needed.",
          },
          gender: {
            type: "string",
            enum: ["Male", "Female", "Other"],
            description:
              "Male, Female, or Other. On Hindi/Gujarati calls the agent asks the caller using the English words male, female, other — use that result here.",
          },
          phoneNumber: {
            type: "string",
            description:
              "Optional. If omitted or 'not provided', the system uses the phone number Exotel received the call from.",
          },
          reason: {
            type: "string",
            description:
              "Symptom/illness in English. Preserve exact English disease names (e.g. piles, diabetes, BP) if the caller said them.",
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
        "List ALL doctors for the current hospital. Returns every doctor with _id, fullName, designation (e.g. Cardiologist, Dermatologist), availability, status. Use this list to pick the doctor whose designation matches the patient's illness, then use that doctor's _id as doctorObjectId when calling create_appointment.",
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
        "Search doctors by name or designation within the current hospital (optional filter). Returns matching doctors with _id. To get the full list first, use list_doctors instead. Use the selected doctor's _id as doctorObjectId when calling create_appointment.",
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
        "Create an appointment linking patient and doctor by their database _id. reason must be the illness/symptom the caller stated during this call, in English. If the caller said an English disease name (e.g. piles, diabetes, BP, fever), use that exact word; otherwise use the English equivalent of what they said.",
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
              "The patient's _id from fetch_patient_by_patientId, fetch_patient_by_phone, or create_patient result (MongoDB ObjectId)",
          },
          reason: {
            type: "string",
            description:
              "The illness/symptom in English, exactly as the caller said or its English equivalent (e.g. piles, diabetes, BP). Preserve English disease names as-is. Use only what was said in this call, not the patient's old reason.",
          },
          appointmentDateTimeISO: {
            type: "string",
            description: "UTC ISO string, e.g. 2026-02-12T12:00:00.000Z",
          },
          type: { type: "string", default: "call" },
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
