const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function extractAppointmentFromTranscript({
  callTranscript,
  appointmentDetails,
  doctorMapping = {},
  patientMapping = {},
  defaultYear = new Date().getFullYear(),
}) {
  const systemPrompt = `
You are an appointment-extraction assistant.

You must read the provided call transcript and appointmentDetails JSON and return ONE appointment object.

Rules:
1. Return ONLY valid JSON. No markdown, no extra text.
2. status must ALWAYS be "Upcoming".
3. type must ALWAYS be "call".
4. hospital must be extracted from appointmentDetails or transcript.
5. doctorId must be resolved using doctorMapping if doctor name is found.
6. patientId must be resolved using patientMapping using phone if available.
7. reason should be extracted if present, else "".
8. appointmentDateTime must be ISO string in UTC (example: "2026-02-12T12:00:00.000Z")
9. If date or time is missing, set appointmentDateTime to null.
10. If doctorId/patientId cannot be resolved, return null for them.
`;

  const userPrompt = `
INPUT JSON:
${JSON.stringify(
  {
    callTranscript,
    appointmentDetails,
    doctorMapping,
    patientMapping,
    defaultYear,
  },
  null,
  2,
)}

Return final JSON in this structure:

{
  "hospital": "",
  "doctorId": "",
  "patientId": "",
  "reason": "",
  "status": "Upcoming",
  "type": "call",
  "appointmentDateTime": ""
}

Return ONLY JSON.
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
  });

  // The output is plain text, so parse it as JSON
  const rawText = response.output_text?.trim();

  try {
    return JSON.parse(rawText);
  } catch (err) {
    console.error("OpenAI returned invalid JSON:", rawText);
    throw new Error("Failed to parse OpenAI JSON output");
  }
}

module.exports = { extractAppointmentFromTranscript };
