/**
 * OpenAI Realtime API tool definitions for the voice agent.
 *
 * @param {{ includeBookingTools?: boolean }} [opts]
 *    When `includeBookingTools` is false, `create_patient` and `create_appointment`
 *    are omitted (e.g. LiveKit: booking runs after the call from the transcript).
 */
function getRealtimeTools(opts = {}) {
  const includeBooking =
    opts.includeBookingTools !== false;

  const tools = [
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
    ...(includeBooking
      ? [
          {
            type: "function",
            name: "create_patient",
            description:
              "Create a new patient for the current hospital and return patientId + details including _id. The caller's phone number from the call is automatically used for phoneNumber when not provided. Use the returned _id when linking to an appointment via create_appointment. The agent asks **age and gender in one combined question** after the name. For age: always pass an **integer** (years) — the caller may say the age in Hindi or Gujarati; convert words like चौबीस→24, पचीस→25 to a number, never a string. For gender: use Male/Female/Other from that reply (or a short follow-up if they only answered one part).",
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
                    "Symptom/illness in English. Preserve exact English disease names (e.g. piles, diabetes, BP) if the caller said them.",
                },
              },
              required: ["fullName", "age", "gender", "reason"],
              additionalProperties: false,
            },
          },
        ]
      : []),
    {
      type: "function",
      name: "list_doctors",
      description:
        "List ALL doctors for the current hospital. Returns each doctor with _id, fullName, designation, availability (this field is their timetable / usual working hours as text — not live free-busy data), status. Pick designation from visit reason. Use doctor _id as doctorObjectId. When choosing time, align clock time with that timetable text only; there is no on-call slot inventory.",
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
        "Search doctors by name or designation. Returns matching rows with timetable text in availability (working hours label, not real-time slot gaps). Use selected _id for create_appointment. Match proposed clock time to that timetable only (voice section 6b). Prefer list_doctors for the full roster.",
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
      name: "check_booking_calendar_date",
      description:
        "Check whether a calendar date (India IST) is a Sunday. The clinic does not accept Sunday appointments. Call this as soon as you have resolved the caller's date to YYYY-MM-DD (e.g. from '15 May' + year rules in section 5), BEFORE finalizing the date or collecting time. If ok is false with code CLINIC_CLOSED_SUNDAY, apologize in the caller's language and ask them to choose another date.",
      parameters: {
        type: "object",
        properties: {
          dateYmd: {
            type: "string",
            description:
              "Calendar date as YYYY-MM-DD (India / IST wall date), e.g. 2026-05-15",
          },
        },
        required: ["dateYmd"],
        additionalProperties: false,
      },
    },
    ...(includeBooking
      ? [
          {
            type: "function",
            name: "create_appointment",
            description:
              "Create an appointment linking patient and doctor by their database _id. reason must be the illness/symptom the caller stated during this call, in English. If the caller said an English disease name (e.g. piles, diabetes, BP, fever), use that exact word; otherwise use the English equivalent of what they said. Before calling this tool, the assistant must say a short wait line in the caller's language, then call this function. On success the result includes messageHindi and messageGujarati — read once as booking status only (caller already confirmed); do not ask to confirm again. On failure: messageHindi, messageGujarati, code — always address the caller in their chosen language, never read raw English to them.",
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
                  description:
                    "Appointment date+time as ISO with India offset +05:30 (IST wall clock), e.g. 2026-04-25T15:30:00+05:30. The caller may say date/time in Hindi or Gujarati (month names, आज/कल, साढ़े तीन, etc.) — convert to this format. Prefer +05:30; trailing Z is interpreted as IST wall time by the server, not UTC.",
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
        ]
      : []),
  ];
  return tools;
}

module.exports = { getRealtimeTools };
