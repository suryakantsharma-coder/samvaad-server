/**
 * Plain text from a LiveKit ChatMessage (string parts or structured { text } blocks).
 * textContent only joins string entries — if content is [{ type, text }], it would be empty otherwise.
 */
function getPlainTranscript(msg) {
  if (!msg) return "";
  const tc = msg.textContent;
  if (typeof tc === "string" && tc.trim()) return tc.trim();
  const c = msg.content;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const part of c) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      const t = part.text ?? part.transcript;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Short spoken yes/no (haa, ha, nahi…) often get misread by the LLM if left as 2–3 Latin letters.
 * Coerce *only* very short, whole-turn transcripts into a clear line the model can follow.
 * @param { { content: unknown, textContent?: string } } msg - ChatMessage with mutable .content
 */
function normalizeShortYesNoInPlace(msg) {
  if (!msg || !Array.isArray(msg.content)) return;
  const raw = getPlainTranscript(msg);
  if (!raw) return;
  if (raw.length > 40) return;

  const noPunct = raw.replace(/[\s\.\,\!\?।…]+/g, "");
  const compact = noPunct;

  if (isShortAffirmative(compact, raw)) {
    msg.content = [
      "Haan. (The caller is saying YES — you heard: ha, haa, haaa, h, haan, हाँ, હા, or equivalent; treat as full agreement to your last question or final booking confirmation.)",
    ];
  } else if (isShortNegation(compact, raw)) {
    msg.content = [
      "Nahi. (The caller is saying NO — nahi, na, naa, no, or equivalent; treat as full disagreement to your last question.)",
    ];
  }
}

function isShortAffirmative(c, rawForScript) {
  const raw = rawForScript || c;
  if (c.length > 12) return false;
  if (/^h+$/i.test(c)) return true; // h, hh (STT quirk)
  if (/^ha+$/i.test(c)) return true; // ha, haa, haaa
  if (/^ha+j+i!?$/i.test(c)) return true; // haji, ha ji
  if (/^ha+an?$/i.test(c)) return true; // haan, haa
  if (/^h+a{1,3}n+$/i.test(c)) return true; // haaan
  if (/^han$/i.test(c)) return true; // "han" mis-STT
  if (/^j+i!*$/i.test(c)) return true; // "ji" assent
  if (/^j+i!*ha+!?$/i.test(c)) return true; // jihaan, ji ha
  if (
    /^th?e+ik$/i.test(c) ||
    /^t+h+ik$/i.test(c) ||
    /^t+h+i+k$/i.test(c) ||
    /^t+h+e+k$/i.test(c)
  ) {
    return true; // theek, thik
  }
  if (/^o+k+$/i.test(c) || /^y+a+s!*$/i.test(c)) return true; // ok, yas, ya
  if (/^ha+n$/i.test(c) && c.length <= 5) return true; // haan, han
  // Devanagari: हा, हाँ, हां (with or without nukta variants STT might emit)
  if (/^हा$/u.test(raw) || /^हाँ$/u.test(raw) || /^हां$/u.test(raw)) return true;
  if (/^ह[ाँा]+$/u.test(c) || /^ह+ा+ँ?$/u.test(c) || /^ह{1,3}ा$/u.test(c))
    return true;
  // Gujarati: હા, હાં
  if (/^હા$/u.test(raw) || /^હાં$/u.test(raw)) return true;
  return false;
}

function isShortNegation(c, rawForScript) {
  const raw = rawForScript || c;
  if (c.length > 12) return false;
  if (/^na+$/i.test(c)) return true; // na, naa, naaa
  if (/^n+a{1,2}h?i*$/i.test(c)) return true; // nahi, nai
  if (/^no!*$/i.test(c) || /^nope$/i.test(c)) return true;
  if (/^galat+$/i.test(c) || /^galt!*$/i.test(c)) return true; // galat, galat
  if (/^nahi$/i.test(c)) return true; // nahi
  if (/^नही$|^नहीं$|^ना$/u.test(c)) return true; // Nahi, Na
  if (/^ના$/u.test(raw) || /^નહી$/u.test(raw)) return true; // Gujarati na
  return false;
}

module.exports = { normalizeShortYesNoInPlace, getPlainTranscript };
