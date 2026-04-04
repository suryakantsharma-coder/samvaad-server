const OpenAI = require("openai");

const { getPortalHintForAssistant } = require("../utils/prescriptionPortalUrl");

let client = null;

function getClient() {
  if (!client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    client = new OpenAI({ apiKey: key });
  }
  return client;
}

/**
 * Short general answer with safety posture.
 * @param {string} userText
 * @param {{ recentSnippets?: string[], hospitalName?: string, hospitalPhone?: string | null }} [opts]
 */
async function answerGeneralQuestion(userText, opts = {}) {
  const api = getClient();
  const snippets = (opts.recentSnippets || []).filter(Boolean).slice(-6);
  const hospitalName = String(opts.hospitalName || "").trim() || "this hospital";
  const hospitalPhone = opts.hospitalPhone ? String(opts.hospitalPhone).trim() : "";

  if (!api) {
    return `Thank you for reaching out.\n\nI am not a medical professional; please consult a qualified clinician for personal health advice.\n\nFor help from *${hospitalName}*${hospitalPhone ? `, please call ${hospitalPhone}` : ", please contact the hospital directly"}.\n\nNote: The automated assistant is not fully configured.`;
  }

  const portalPattern = getPortalHintForAssistant();
  const portalLine = portalPattern
    ? `Official prescription / patient portal URL pattern (share when user asks for full prescription details, links, or the website): ${portalPattern}. Do not refuse to share this; tell them to log in with their registered phone or open the link their hospital sent.`
    : "If the user asks for full prescription details or official records, tell them to type *prescriptions* in this chat to open the prescription menu with website links, or contact the hospital.";

  const identity = hospitalPhone
    ? `You represent *${hospitalName}* on WhatsApp. The hospital's main phone is ${hospitalPhone}. Direct people to *${hospitalName}* for in-person care, reception, and appointments — not to a generic "nearest" clinic or random facility.`
    : `You represent *${hospitalName}* on WhatsApp. Direct people to *${hospitalName}* for in-person care, reception, and appointments — not to a generic "nearest" clinic or random facility.`;

  const system = [
    "You are the official WhatsApp assistant for a hospital.",
    "Tone: warm, courteous, and professional — similar to a skilled reception or patient-services team member.",
    "Formatting: use short paragraphs separated by a blank line when helpful. You may use WhatsApp *bold* only for the hospital name and essential next steps.",
    identity,
    "Reply in clear English only. Keep answers brief (about 2–4 sentences unless the user asks for detail).",
    "Never diagnose or prescribe. If they need clinical judgment, say they should see a qualified clinician at *" +
      hospitalName +
      "* (or the emergency department there if appropriate).",
    "Do not tell them to visit the \"nearest hospital\", \"any clinic\", or unnamed facilities — always tie guidance to *" +
      hospitalName +
      "*.",
    "When they ask where to go or what to do about feeling unwell, invite them to visit or call *" +
      hospitalName +
      "*" +
      (hospitalPhone ? ` (${hospitalPhone})` : "") +
      " and offer to help book an appointment in this chat (they can type *appointment*).",
    "When the topic is health or symptoms, briefly include: I am not a medical professional; please see a qualified clinician for personal medical advice.",
    portalLine,
  ].join(" ");

  const ctx =
    snippets.length > 0
      ? `\nRecent chat (context only, do not quote verbatim):\n${snippets.join("\n")}`
      : "";

  const res = await api.chat.completions.create({
    model: process.env.WHATSAPP_CHAT_OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 200,
    messages: [
      { role: "system", content: system + ctx },
      { role: "user", content: String(userText || "").trim() },
    ],
  });

  const text = res.choices?.[0]?.message?.content?.trim();
  return (
    text ||
    "Thank you for your message. I am not a medical professional; please consult a qualified clinician for personal health advice."
  );
}

const PATIENT_DETAIL_RE =
  /Name:\s*(.+)[\r\n]+Age:\s*(\d+)[\r\n]+Gender:\s*([\s\S]+?)[\r\n]+(?:Problem|Reason|Disease):\s*([\s\S]+)/i;

/**
 * Extract new-patient block from a free-form message (regex first; optional AI fill-in).
 */
async function extractNewPatientDetails(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const m = raw.match(PATIENT_DETAIL_RE);
  if (m) {
    return {
      name: m[1].trim(),
      age: parseInt(m[2], 10),
      gender: m[3].trim().split(/\r?\n/)[0].trim(),
      disease: m[4].trim().split(/\r?\n/)[0],
    };
  }

  const api = getClient();
  if (!api) return null;

  const res = await api.chat.completions.create({
    model: process.env.WHATSAPP_CHAT_OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Extract patient details from the user message. Reply JSON only: {"name":"","age":0,"gender":"","disease":""}. Use empty strings/0 if missing.',
      },
      { role: "user", content: raw },
    ],
  });

  const content = res.choices?.[0]?.message?.content?.trim();
  if (!content) return null;
  try {
    const o = JSON.parse(content);
    if (!o || !o.name || !o.age) return null;
    return {
      name: String(o.name).trim(),
      age: parseInt(String(o.age), 10),
      gender: String(o.gender || "").trim(),
      disease: String(o.disease || "").trim() || "Consultation",
    };
  } catch {
    return null;
  }
}

module.exports = {
  answerGeneralQuestion,
  extractNewPatientDetails,
};
