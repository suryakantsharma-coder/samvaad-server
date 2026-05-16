/** @typedef {'hi' | 'gu' | 'en'} PreferredLanguage */

const GUJARATI_SCRIPT_RE = /[\u0A80-\u0AFF]/;
const GUJARATI_HINT_RE =
  /\b(ગુજરાતી|ગુજરાત|હા|ના|નહીં|કૃપા|આવતી|કાલ|આજ|જી)\b/i;
const HINDI_SCRIPT_RE = /[\u0900-\u097F]/;
const HINDI_HINT_RE =
  /\b(हिंदी|हिन्दी|हाँ|हा|नहीं|कृपया|कल|आज|जी)\b/i;

/** Latin / spoken preference before script heuristics (first reply to language question, etc.). */
const EXPLICIT_GU_RE = /\b(gujarati|gujrati|gujarathi|gujju)\b/i;
const EXPLICIT_HI_RE = /\b(hindi|hindii|hinglish)\b/i;
const EXPLICIT_EN_RE =
  /\b(english|inglish|inglis|angrezi)\b/i;

/**
 * Reply right after "Hindi or English?" that does NOT choose a language — must not lock English.
 * STT often returns "Okay" / "Yes" / "Haan" when the user only acknowledges the greeting.
 * @param {string} text
 */
function isBareLanguageChoiceNonAnswer(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 48) return false;
  if (
    /^(okay|ok|k\.?|yes|yeah|yep|yup|sure|haan|हाँ|हां|ha|hmm|uh-?huh)\.?!?$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(जी|हाँ|हां)(\s+जी)?[.!?]?$/u.test(t)) {
    return true;
  }
  return false;
}

/**
 * Infer caller language from STT text — Hindi vs Gujarati (legacy paths).
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
 * Short Devanagari-only utterance (e.g. name fragment, "गया", STT glitch) —
 * must not flip the whole call to Hindi.
 * @param {string} s
 */
function isShortDevanagariNoise(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 10) return false;
  return /^[\u0900-\u097F\s।,.!?]+$/u.test(t);
}

/** Caller is speaking plain English (Latin) — used to lock **en** when STT has no Devanagari. */
function looksLikeEnglishPrimary(s) {
  const t = String(s || "").trim();
  if (t.length < 3) return false;
  if (/[\u0900-\u097F\u0A80-\u0AFF]/.test(t)) return false;
  if (EXPLICIT_EN_RE.test(t) || /\b(in english|english please)\b/i.test(t)) {
    return true;
  }
  if (
    t.length >= 8 &&
    /\b(the|and|for|with|from|have|has|need|want|this|that|what|when|book|doctor|appointment|visit|morning|afternoon|evening|tomorrow|today|my|name|age|male|female|throat|pain|cough|fever|infection|first|fast)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (t.length >= 22) return true;
  return false;
}

/**
 * Hospital receptionist: Hindi vs English only (no Gujarati lock from STT).
 * @param {string} text
 * @returns {'hi'|'en'|null}
 */
function inferHospitalCallerLanguage(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (isBareLanguageChoiceNonAnswer(s)) return null;
  if (EXPLICIT_EN_RE.test(s)) return "en";
  if (/इंग्लिश|इंग्रेजी|अंग्रेज़ी|अंग्रेजी/.test(s)) return "en";
  if (looksLikeEnglishPrimary(s)) return "en";
  if (/हिंदी|हिन्दी/.test(s) || EXPLICIT_HI_RE.test(s)) return "hi";
  if (isShortDevanagariNoise(s)) return null;
  if (HINDI_SCRIPT_RE.test(s) || HINDI_HINT_RE.test(s)) return "hi";
  if (GUJARATI_SCRIPT_RE.test(s) || GUJARATI_HINT_RE.test(s)) return null;
  if (/\b(hindi|english)\b/i.test(s)) {
    if (/\benglish\b/i.test(s) && !/\bhindi\b/i.test(s)) return "en";
    if (/\bhindi\b/i.test(s) && !/\benglish\b/i.test(s)) return "hi";
  }
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
 * Explicit Hindi ↔ English when hospital language is locked.
 * @param {string} text
 * @returns {'hi'|'en'|null}
 */
function detectExplicitHospitalLanguageSwitch(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 160) return null;
  const toEn =
    EXPLICIT_EN_RE.test(s) ||
    /(अब|कृपया|प्लीज़|please)?\s*(इंग्लिश|अंग्रेज़ी|अंग्रेजी)\s*(में)?/i.test(s) ||
    /\b(speak|switch\s+to|in)\s+english\b/i.test(s) ||
    /\benglish\s*(please|maam|madam)?\b/i.test(s);
  const toHi =
    /(अब|कृपया)?\s*(हिंदी|हिन्दी)\s*(में)?/i.test(s) ||
    /(हिंदी|हिन्दी)\s*(में)?\s*(रख|रखे|रखना|बोल|बात)/i.test(s) ||
    /\bhindi\s+(mein|main)\b/i.test(s) ||
    /\b(speak|switch\s+to)\s+hindi\b/i.test(s) ||
    /\bhindi\s*(please|maam|madam)?\b/i.test(s);
  if (toEn && !toHi) return "en";
  if (toHi && !toEn) return "hi";
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
  if (lang === "en") {
    return (
      "URGENT_ONE_TURN — caller audio was unclear. You are Neha (female receptionist). Say exactly ONE short English line: " +
      '"Sorry, I did not catch that clearly — could you say that once more?" ' +
      "Then repeat only your immediate last question in one short natural English line. Do NOT call tools."
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
  if (lang === "en") {
    return (
      "URGENT_ONE_TURN — no user response was detected after your last question. You are Neha (female receptionist). " +
      'Say exactly ONE short English line: "Sorry, I did not hear a reply — could you please say that again?" ' +
      "Then repeat only your immediate last question in one short natural English line — not the whole booking summary." +
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
const HANG_UP_EN =
  "If you need anything else, just say so; otherwise you may hang up. Thank you.";

module.exports = {
  detectPreferredLanguage,
  inferCallerLanguage,
  inferHospitalCallerLanguage,
  detectExplicitLanguageSwitch,
  detectExplicitHospitalLanguageSwitch,
  getEmptyInputRepromptInstructions,
  getNoInputRepromptInstructions,
  HANG_UP_HI,
  HANG_UP_GU,
  HANG_UP_EN,
};
