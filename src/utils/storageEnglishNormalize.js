const OpenAI = require("openai");

const MODEL =
  process.env.STORAGE_ENGLISH_MODEL ||
  process.env.TRANSCRIPT_TRANSLATE_MODEL ||
  "gpt-4.1-mini";

/**
 * Map common caller / STT outputs to Patient schema enum before LLM pass.
 * @param {string|null|undefined} raw
 * @returns {"Male"|"Female"|"Other"}
 */
function normalizeGenderEnum(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Other";
  const lower = s.toLowerCase();
  if (["male", "m", "man", "boy"].includes(lower)) return "Male";
  if (["female", "f", "woman", "girl"].includes(lower)) return "Female";
  if (["other", "o", "unknown"].includes(lower)) return "Other";
  if (/पुरुष|लड़का|लडका/i.test(s)) return "Male";
  if (/महिला|स्त्री|लड़की|लडकी|औरत/i.test(s)) return "Female";
  if (/પુરુષ/i.test(s)) return "Male";
  if (/સ્ત્રી|મહિલા/i.test(s)) return "Female";
  if (/अन्य|અન્ય/i.test(s)) return "Other";
  return "Other";
}

/**
 * Patient create: name + reason + gender → English-safe DB values (OpenAI when key set).
 * @param {{ fullName: string, reason: string, gender: string }} fields
 */
async function normalizePatientFieldsForStorage(fields) {
  const fn = String(fields.fullName || "").trim();
  const rs = String(fields.reason || "").trim();
  const gFallback = normalizeGenderEnum(fields.gender);

  if (!fn || !rs) {
    return { fullName: fn, reason: rs, gender: gFallback };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { fullName: fn, reason: rs, gender: gFallback };
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You normalize patient fields for a hospital database. Caller may have spoken Hindi or Gujarati.
Return JSON only:
{
  "fullNameEnglish": string — full name in English using Latin letters (romanize Indian names; Title Case),
  "reasonEnglish": string — chief complaint / symptoms in short English (medical plain language),
  "gender": "Male" | "Female" | "Other"
}
Use English only in fullNameEnglish and reasonEnglish. gender must be exactly Male, Female, or Other.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            fullName: fn,
            reason: rs,
            genderHint: gFallback,
          }),
        },
      ],
    });

    const raw = (response.choices?.[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw);
    let outG = parsed.gender;
    if (outG !== "Male" && outG !== "Female" && outG !== "Other") {
      outG = gFallback;
    }
    return {
      fullName: String(parsed.fullNameEnglish || fn).trim() || fn,
      reason: String(parsed.reasonEnglish || rs).trim() || rs,
      gender: outG,
    };
  } catch (err) {
    console.warn(
      "[storageEnglishNormalize] normalizePatientFieldsForStorage:",
      err.message,
    );
    return { fullName: fn, reason: rs, gender: gFallback };
  }
}

/**
 * Appointment reason only → English for DB.
 * @param {string} reason
 */
async function normalizeReasonForStorage(reason) {
  const rs = String(reason || "").trim();
  if (!rs) return rs;
  if (!process.env.OPENAI_API_KEY) return rs;

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Return JSON only: { "reasonEnglish": "..." } — short English symptom/reason for medical records. Caller text may be Hindi or Gujarati; output English only.`,
        },
        { role: "user", content: rs },
      ],
    });
    const raw = (response.choices?.[0]?.message?.content || "").trim();
    const parsed = JSON.parse(raw);
    return String(parsed.reasonEnglish || rs).trim() || rs;
  } catch (err) {
    console.warn(
      "[storageEnglishNormalize] normalizeReasonForStorage:",
      err.message,
    );
    return rs;
  }
}

module.exports = {
  normalizeGenderEnum,
  normalizePatientFieldsForStorage,
  normalizeReasonForStorage,
};
