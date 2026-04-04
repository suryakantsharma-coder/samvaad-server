/**
 * Hospital rule: chat in English; ask to switch only for non‑English writing systems.
 *
 * WhatsApp / mobile keyboards sometimes insert:
 * - Cyrillic (or other) lookalikes for Latin letters → false match on \p{Script=Cyrillic}
 * - Invisible bidi / ZWJ characters
 *
 * We NFC-normalize, strip those, then block only when the message is *actually* in
 * another script (Arabic, Devanagari, CJK, …) or clearly Cyrillic-heavy text.
 */

const NON_LATIN_SCRIPT_RE =
  /\p{Script=Arabic}|\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Gujarati}|\p{Script=Gurmukhi}|\p{Script=Malayalam}|\p{Script=Kannada}|\p{Script=Oriya}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Hebrew}|\p{Script=Thai}|\p{Script=Ethiopic}|\p{Script=Georgian}|\p{Script=Armenian}|\p{Script=Myanmar}/u;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const GREEK_RE = /\p{Script=Greek}/u;
const CJK_BLOCK_RE = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

/** Bidi / format characters sometimes present in mobile payloads */
const INVISIBLE_RE = /[\u200B-\u200D\uFEFF\u2060\u200E\u200F\u202A-\u202E]/g;

function countMatches(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

/**
 * @param {string} text
 * @returns {boolean} true if we should treat the message as OK for English conversation
 */
function isEnglishMessage(text) {
  let s = String(text || "").normalize("NFC").trim();
  if (!s) return true;

  s = s.replace(INVISIBLE_RE, "");

  if (CJK_BLOCK_RE.test(s)) return false;

  if (NON_LATIN_SCRIPT_RE.test(s)) return false;

  const cyrillic = countMatches(s, CYRILLIC_RE);
  const greek = countMatches(s, GREEK_RE);
  const latin = countMatches(s, /\p{Script=Latin}/gu);

  if (cyrillic > 0 || greek > 0) {
    const confusable = cyrillic + greek;
    /** Mostly Latin + a few Cyrillic/Greek homoglyphs (e.g. fake "a") → still English */
    if (latin >= confusable * 2) return true;
    return false;
  }

  return true;
}

module.exports = {
  isEnglishMessage,
};
