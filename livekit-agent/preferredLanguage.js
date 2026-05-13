/** @typedef {'hi' | 'gu'} PreferredLanguage */

const GUJARATI_SCRIPT_RE = /[\u0A80-\u0AFF]/;
const GUJARATI_HINT_RE =
  /\b(ગુજરાતી|ગુજરાત|હા|ના|નહીં|કૃપા|આવતી|કાલ|આજ|જી)\b/i;
const HINDI_SCRIPT_RE = /[\u0900-\u097F]/;
const HINDI_HINT_RE =
  /\b(हिंदी|हिन्दी|हाँ|हा|नहीं|कृपया|कल|आज|जी)\b/i;

/** Latin / spoken preference before script heuristics (first reply to language question, etc.). */
const EXPLICIT_GU_RE = /\b(gujarati|gujrati|gujarathi|gujju)\b/i;
const EXPLICIT_HI_RE = /\b(hindi|hindii|hinglish)\b/i;

/**
 * Infer caller language from STT text (Hindi vs Gujarati).
 * @param {string} text
 * @returns {PreferredLanguage | null}
 */
function detectPreferredLanguage(text) {
  return inferCallerLanguage(text);
}

/**
 * Same as detectPreferredLanguage but name reflects use before language is locked.
 * Order: explicit spoken preference → Gujarati script/hints → Hindi script/hints.
 * @param {string} text
 * @returns {PreferredLanguage | null}
 */
function inferCallerLanguage(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (/ગુજરાતી/.test(s) || EXPLICIT_GU_RE.test(s)) return "gu";
  /* Hindi script used to write "Gujarati" e.g. गुजराती में बात */
  if (/गुजराती|गુજરાતી/i.test(s)) return "gu";
  if (/हिंदी|हिन्दी/.test(s) || EXPLICIT_HI_RE.test(s)) return "hi";
  if (GUJARATI_SCRIPT_RE.test(s) || GUJARATI_HINT_RE.test(s)) return "gu";
  if (HINDI_SCRIPT_RE.test(s) || HINDI_HINT_RE.test(s)) return "hi";
  return null;
}

/**
 * When call language is already locked: only change if the caller clearly asks.
 * @param {string} text
 * @returns {PreferredLanguage | null}
 */
function detectExplicitLanguageSwitch(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 160) return null;
  const toGu =
    /(હવે|ફરી|બદલીને)?\s*(ગુજરાતી)\s*(માં)?/i.test(s) ||
    /(अब|अब\s*से|फिर)?\s*(गुजराती)\s*(में)?/i.test(s) ||
    /\b(speak|switch\s+to)\s+gujarati\b/i.test(s) ||
    /\bgujarati\s*(please|maam|madam)?\b/i.test(s);
  const toHi =
    /(હવે|ફરી)?\s*(હિંદી)\s*(માં)?/i.test(s) ||
    /(अब|फिर)?\s*(हिंदी|हिन्दी)\s*(में)?/i.test(s) ||
    /\b(speak|switch\s+to)\s+hindi\b/i.test(s) ||
    /\bhindi\s*(please|maam|madam)?\b/i.test(s);
  if (toGu && !toHi) return "gu";
  if (toHi && !toGu) return "hi";
  if (toGu && toHi) return null;
  return null;
}

/**
 * @param {PreferredLanguage | null | undefined} lang
 */
function getEmptyInputRepromptInstructions(lang) {
  if (lang === "gu") {
    return (
      "URGENT_ONE_TURN — caller audio was unclear. You are Neha (female receptionist). Say exactly ONE short Gujarati line: " +
      '"માફ કરશો, મને સાફ સમજાયું નથી—એકવાર ફરી કહેશો?" ' +
      "Then repeat only your immediate last question in one short natural Gujarati line. Do NOT call tools."
    );
  }
  return (
    "URGENT_ONE_TURN — caller audio was unclear. You are Neha (female receptionist). Say exactly ONE short Hindi line: " +
    '"माफ़ कीजिए, मुझे साफ़ सुनाई नहीं दी—ज़रा एक बार फिर बोलिए?" ' +
    "Then repeat only your immediate last question in one short natural Hindi line. Do NOT call tools."
  );
}

/**
 * @param {PreferredLanguage | null | undefined} lang
 * @param {{ missingTopic?: string | null }} [opts]
 */
function getNoInputRepromptInstructions(lang, opts = {}) {
  const topic = opts.missingTopic;
  const topicHint = topic
    ? ` If it helps, ask ONLY for this in one short line: ${topic}.`
    : "";
  if (lang === "gu") {
    return (
      "URGENT_ONE_TURN — no user response was detected after your last question. You are Neha (female receptionist). " +
      'Say exactly ONE short Gujarati line: "માફ કરશો, મને તમારો જવાબ સાફ સાંભળાયો નહીં—એકવાર ફરી બોલશો?" ' +
      "Then repeat only your immediate last question in one short natural Gujarati line — not the whole booking summary." +
      topicHint +
      " Do NOT call tools."
    );
  }
  return (
    "URGENT_ONE_TURN — no user response was detected after your last question. You are Neha (female receptionist). " +
    'Say exactly ONE short Hindi line: "माफ़ कीजिए, मुझे आपकी आवाज़ साफ़ नहीं आई—ज़रा एक बार फिर बोलिए?" ' +
    "Then repeat only your immediate last question in one short natural Hindi line — not the whole booking summary." +
    topicHint +
    " Do NOT call tools."
  );
}

const HANG_UP_HI =
  "अगर और कुछ पूछना हो तो बताइएगा; वरना आप कॉल काट सकते हैं। धन्यवाद।";
const HANG_UP_GU =
  "જો હજી કંઈ પૂછવું હોય તો કહેજો; નહીંતર તમે ફોન મૂકી શકો છો. આભાર.";

module.exports = {
  detectPreferredLanguage,
  inferCallerLanguage,
  detectExplicitLanguageSwitch,
  getEmptyInputRepromptInstructions,
  getNoInputRepromptInstructions,
  HANG_UP_HI,
  HANG_UP_GU,
};
