const OpenAI = require("openai");
const {
  buildExtractionSystemPrompt,
  buildExtractionUserContent,
} = require("../prompts/extractionPrompt");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Call OpenAI to extract structured appointment information from a call transcript.
 * This is a pure function: it does not touch the database; it only calls the model
 * and parses AppointmentExtractionOutput.
 */
async function extractAppointmentFromTranscript(input) {
  const system = buildExtractionSystemPrompt();
  const user = buildExtractionUserContent(input);

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  });

  const rawText = (response.output_text || "").trim();
  if (!rawText) {
    throw new Error("OpenAI returned empty extraction response");
  }

  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Parsed extraction output is not an object");
    }
    if (
      parsed.action !== "create_appointment_for_existing_patient" &&
      parsed.action !== "create_new_patient_and_appointment" &&
      parsed.action !== "no_appointment"
    ) {
      throw new Error(`Invalid action in extraction output: ${parsed.action}`);
    }
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[extractAppointmentFromTranscript] Failed to parse JSON from OpenAI:",
      rawText,
    );
    throw err instanceof Error
      ? err
      : new Error("Failed to parse AppointmentExtractionOutput JSON");
  }
}

module.exports = {
  extractAppointmentFromTranscript,
};

