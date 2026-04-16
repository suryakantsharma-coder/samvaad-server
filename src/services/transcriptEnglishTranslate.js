const OpenAI = require("openai");

/**
 * Translate transcript turns to English for storage and downstream extraction.
 * Preserves role order and count.
 * @param {{ role: string, text: string }[]} turns
 * @returns {Promise<{ role: string, text: string }[]>}
 */
async function translateTranscriptTurnsToEnglish(turns) {
  if (!turns.length) return [];
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for English transcript storage");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model =
    process.env.TRANSCRIPT_TRANSLATE_MODEL ||
    process.env.EXTRACTION_MODEL ||
    "gpt-4.1-mini";

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You translate hospital phone-call transcript lines into clear English for medical records.
Rules:
- Output MUST be valid JSON: { "turns": [ {"role":"user"|"assistant","text":"English text here"} ] }.
- The array length and each "role" MUST match the input exactly in order.
- Use English only in "text" fields (no Hindi or Gujarati script in output).
- Keep doctor names, hospital names, and medicine names as commonly written in English.
- Preserve numbers, dates, and times as spoken meaning would be in English (e.g. "3 PM").`,
      },
      {
        role: "user",
        content: JSON.stringify({ turns }),
      },
    ],
  });

  const raw = (response.choices?.[0]?.message?.content || "").trim();
  if (!raw) throw new Error("Empty translation response");

  const parsed = JSON.parse(raw);
  const out = parsed.turns;
  if (!Array.isArray(out) || out.length !== turns.length) {
    throw new Error("Translation output shape mismatch");
  }
  for (let i = 0; i < turns.length; i += 1) {
    if (out[i].role !== turns[i].role) {
      throw new Error(`Translation role mismatch at index ${i}`);
    }
    if (typeof out[i].text !== "string" || !out[i].text.trim()) {
      throw new Error(`Translation empty text at index ${i}`);
    }
  }
  return out.map((t) => ({ role: t.role, text: String(t.text).trim() }));
}

module.exports = { translateTranscriptTurnsToEnglish };
