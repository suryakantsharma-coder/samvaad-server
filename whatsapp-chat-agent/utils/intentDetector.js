const INTENTS = {
  BOOK_APPOINTMENT: "BOOK_APPOINTMENT",
  GET_PRESCRIPTION: "GET_PRESCRIPTION",
  GENERAL: "GENERAL",
};

/**
 * Parking, building, visitor services, etc. — answer via AI + direct user to call hospital;
 * do not start structured book / prescription flows just because "appointment" appears elsewhere.
 */
const FACILITY_OR_STRUCTURAL_RE =
  /\b(parking|park\s+(here|there|available|space|lot|area)|valet|wifi|wi-?fi|internet\s+access|canteen|cafeteria|food\s+court|café|cafe|visitor|visiting\s+hours|overnight\s+stay|private\s+room|shared\s+room|general\s+ward|icu\b|wheelchair|elevator|lift|escalator|ramp|ambulance\s+entrance|directions|how\s+to\s+(get|reach)|reach\s+the\s+hospital|location\s+of|map|building|structure|accommodation|lockers?|atm\b|security\s+gate|cloak|restroom|washroom|toilet|water\s+cooler|waiting\s+area|lounge)\b/i;

/** User is referring to an appointment they already have / a date, not asking to open the booking wizard */
const HAVE_APPOINTMENT_CONTEXT_RE =
  /\b(i\s+have|i'?ve\s+got|already\s+have|got\s+an?\s+appointment|my\s+appointment|appointment\s+(on|for|at|this|next|tomorrow|today))\b/i;

/** Clear request to start booking */
const STRONG_BOOK_RE =
  /\b(book|booking|schedule|reserve|set\s+up|make|create)\s+(an?\s+)?(appointment|visit|slot|consultation)|\b(need|want|get|i'?d\s+like)\s+(an?\s+)?appointment\b|^\s*(book|schedule)\b/i;

/** Clear request for prescription links / repeats */
const STRONG_RX_RE =
  /\b(get|show|send|need|want|check|view|open|download|my)\s+(the\s+|my\s+)?(prescription|prescriptions|\brx\b|medicine\s+list)|\bprescription\s+(link|links|copy|record|details)|\brefill\b|\brepeat\s+(prescription|meds)\b/i;

const LOOSE_RX_RE = /\b(prescription|prescriptions|\brx\b)\b/i;

const CONSULT_BOOK_AUX_RE =
  /\b(see\s+a\s+doctor|see\s+the\s+doctor|book\s+a\s+doctor|doctor'?s\s+appointment)\b/i;

/**
 * @param {string} text
 * @returns {string} one of INTENTS
 */
function detectIntent(text) {
  const t = String(text || "").trim();
  if (!t) return INTENTS.GENERAL;

  // One-word / minimal shortcuts (explicit menu-style)
  if (/^\s*(prescription|prescriptions|\brx\b)\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.GET_PRESCRIPTION;
  }
  if (/^\s*(appointment|booking)\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.BOOK_APPOINTMENT;
  }

  if (FACILITY_OR_STRUCTURAL_RE.test(t)) {
    return INTENTS.GENERAL;
  }

  if (HAVE_APPOINTMENT_CONTEXT_RE.test(t)) {
    return INTENTS.GENERAL;
  }

  const longWithPunctuation = t.length >= 42 && /[.?!]/.test(t);
  const hasQuestion = /\?/.test(t);
  if (longWithPunctuation || (hasQuestion && t.length > 38)) {
    if (!STRONG_BOOK_RE.test(t) && !STRONG_RX_RE.test(t)) {
      return INTENTS.GENERAL;
    }
    if (
      STRONG_BOOK_RE.test(t) &&
      /\b(also|;\s|\.+\s+[A-Za-z]|,\s*(is|are|do|does|can|what|where|how|when))\b/i.test(
        t,
      )
    ) {
      return INTENTS.GENERAL;
    }
  }

  if (STRONG_BOOK_RE.test(t)) {
    return INTENTS.BOOK_APPOINTMENT;
  }

  if (STRONG_RX_RE.test(t)) {
    return INTENTS.GET_PRESCRIPTION;
  }

  if (LOOSE_RX_RE.test(t) && t.length < 52) {
    return INTENTS.GET_PRESCRIPTION;
  }

  if (CONSULT_BOOK_AUX_RE.test(t) && t.length < 72) {
    return INTENTS.BOOK_APPOINTMENT;
  }

  return INTENTS.GENERAL;
}

module.exports = {
  INTENTS: Object.freeze(INTENTS),
  detectIntent,
};
