const INTENTS = {
  BOOK_APPOINTMENT: "BOOK_APPOINTMENT",
  GET_PRESCRIPTION: "GET_PRESCRIPTION",
  GENERAL: "GENERAL",
};

const BOOK_RE =
  /\b(book|booking|schedule|appointment|visit|doctor|consultation|see\s+a\s+doctor|clinic)\b/i;
const RX_RE =
  /\b(prescription|prescriptions|medicine|medicines|medication|medications|rx|refill|drugs?)\b/i;

/**
 * @param {string} text
 * @returns {string} one of INTENTS
 */
function detectIntent(text) {
  const t = String(text || "").trim();
  if (!t) return INTENTS.GENERAL;

  if (BOOK_RE.test(t)) return INTENTS.BOOK_APPOINTMENT;
  if (RX_RE.test(t)) return INTENTS.GET_PRESCRIPTION;

  return INTENTS.GENERAL;
}

module.exports = {
  INTENTS: Object.freeze(INTENTS),
  detectIntent,
};
