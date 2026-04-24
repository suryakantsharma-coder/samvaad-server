/**
 * Short spoken yes/no (haa, ha, nahi…) often get misread by the LLM if left as 2–3 Latin letters.
 * Coerce *only* very short, whole-turn transcripts into a clear line the model can follow.
 * @param { { content: unknown, textContent?: string } } msg - ChatMessage with mutable .content
 */
function normalizeShortYesNoInPlace(msg) {
  if (!msg || !Array.isArray(msg.content)) return;
  const raw = (msg.textContent && String(msg.textContent).trim()) || "";
  if (!raw) return;
  if (raw.length > 40) return;

  const noPunct = raw.replace(/[\s\.\,\!\?।…]+/g, "");
  const compact = noPunct;

  if (isShortAffirmative(compact)) {
    msg.content = [
      "Haan. (The caller is saying YES — you heard: ha, haa, haaa, h, haan, or equivalent; treat as full agreement to your last question.)",
    ];
  } else if (isShortNegation(compact)) {
    msg.content = [
      "Nahi. (The caller is saying NO — nahi, na, naa, no, or equivalent; treat as full disagreement to your last question.)",
    ];
  }
}

function isShortAffirmative(c) {
  if (c.length > 10) return false;
  if (/^h+$/i.test(c)) return true; // h, hh (STT quirk)
  if (/^ha+$/i.test(c)) return true; // h, ha, haa, haaa
  if (/^ha+an?$/i.test(c)) return true; // haan, haa
  if (/^h+a{1,3}n+$/i.test(c)) return true; // haaan
  if (/^han$/i.test(c)) return true; // "han" mis-STT
  if (/^j+i!*$/i.test(c)) return true; // "ji" assent
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
  if (/^ह[ाँा]+$/u.test(c) || /^ह+ा+ँ?$/u.test(c) || /^ह{1,3}ा$/u.test(c)) return true; // devanagari
  return false;
}

function isShortNegation(c) {
  if (c.length > 12) return false;
  if (/^na+$/i.test(c)) return true; // na, naa, naaa
  if (/^n+a{1,2}h?i*$/i.test(c)) return true; // nahi, nai
  if (/^no!*$/i.test(c) || /^nope$/i.test(c)) return true;
  if (/^galat+$/i.test(c) || /^galt!*$/i.test(c)) return true; // galat, galat
  if (/^nahi$/i.test(c)) return true; // nahi
  if (/^नही$|^नहीं$|^ना$/u.test(c)) return true; // Nahi, Na
  return false;
}

module.exports = { normalizeShortYesNoInPlace };
