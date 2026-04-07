const INTENTS = {
  BOOK_APPOINTMENT: "BOOK_APPOINTMENT",
  RESCHEDULE_APPOINTMENT: "RESCHEDULE_APPOINTMENT",
  SHOW_APPOINTMENTS: "SHOW_APPOINTMENTS",
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

const RESCHEDULE_RE =
  /\b(reschedule|re[-\s]?schedule|change|update|modify|move|shift|postpone)\b.*\b(appointment|booking|slot|visit)\b|\b(appointment|booking|slot|visit)\b.*\b(reschedule|re[-\s]?schedule|change|update|modify|move|shift|postpone)\b/i;
const RESCHEDULE_STRONG_RE =
  /^\s*(reschedule|re[-\s]?schedule)\s+(my\s+)?(appointment|booking|slot|visit)\s*[!?.]*\s*$/i;
const CHANGE_APPOINTMENT_RE =
  /^\s*(change|move|shift|postpone)\s+(my\s+)?(appointment|booking|slot|visit)(\s+time|\s+date|\s+date\s+and\s+time)?\s*[!?.]*\s*$/i;
const APPOINTMENT_CHANGE_QUERY_RE =
  /\b(can\s+i|i\s+want\s+to|i\s+need\s+to|please)\s+(reschedule|change|move|shift|postpone)\b.*\b(my\s+)?(appointment|booking|slot|visit)\b/i;
const APPOINTMENT_CHANGE_NATURAL_RE =
  /\b(i\s+want\s+you\s+to|i\s+would\s+like\s+to|help\s+me\s+to)\s+(reschedule|change|move|shift|postpone)\b.*\b(my\s+)?(appointment|booking|slot|visit)\b/i;
/** Anywhere in message — user asked for these exact phrases */
const RESCHEDULE_APPOINTMENT_PHRASE_RE =
  /\b(change|reschedule|update)\s+appointment\b/i;

const RESCHEDULE_ACTION_WORD_RE =
  /\b(reschedule|re[-\s]?schedule|change|update|modify|move|shift|postpone)\b/i;
const SHOW_APPOINTMENTS_RE =
  /\b(show|list|view|check|see)\b.*\b(my\s+)?(upcoming\s+)?appointments?\b|^\s*my\s+appointments?\s*$|^\s*show\s+appointments?\s*$/i;

/**
 * Natural booking requests, e.g. "I want to book my appointment" — must run before
 * HAVE_APPOINTMENT_CONTEXT_RE (which would otherwise match "my appointment" alone).
 */
const BOOK_APPOINTMENT_NATURAL_RE =
  /\b(i\s+)?(want|need|would\s+like|gonna|going\s+to)\s+to\s+(book|schedule|reserve|set\s+up|make|fix)\s+(an?\s+|my\s+|the\s+)?(appointment|visit|slot|consultation)\b|\b(want|need)\s+to\s+(book|schedule)\b.*\bappointment\b|\bbook\s+(my|an?\s+|the\s+)?(appointment|visit|slot|consultation)\b|\b(schedule|make|reserve)\s+(my|an?\s+)?(appointment|visit)\b/i;

/**
 * @param {string} text
 * @returns {string} one of INTENTS
 */
function detectIntent(text) {
  const t = String(text || "").trim();
  if (!t) return INTENTS.GENERAL;

  if (RESCHEDULE_APPOINTMENT_PHRASE_RE.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }

  if (BOOK_APPOINTMENT_NATURAL_RE.test(t)) {
    return INTENTS.BOOK_APPOINTMENT;
  }

  // One-word / minimal shortcuts (explicit menu-style)
  if (/^\s*(prescription|prescriptions|\brx\b)\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.GET_PRESCRIPTION;
  }
  if (/^\s*(appointment|booking)\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.BOOK_APPOINTMENT;
  }
  if (/^\s*reschedule\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (/^\s*reschedule\s+appointment\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (/^\s*change\s+appointment\s*[!?.]*\s*$/i.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (RESCHEDULE_STRONG_RE.test(t) || CHANGE_APPOINTMENT_RE.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (SHOW_APPOINTMENTS_RE.test(t)) {
    return INTENTS.SHOW_APPOINTMENTS;
  }

  if (FACILITY_OR_STRUCTURAL_RE.test(t)) {
    return INTENTS.GENERAL;
  }

  if (
    HAVE_APPOINTMENT_CONTEXT_RE.test(t) &&
    !RESCHEDULE_ACTION_WORD_RE.test(t)
  ) {
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

  if (RESCHEDULE_RE.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (APPOINTMENT_CHANGE_QUERY_RE.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (APPOINTMENT_CHANGE_NATURAL_RE.test(t)) {
    return INTENTS.RESCHEDULE_APPOINTMENT;
  }
  if (SHOW_APPOINTMENTS_RE.test(t)) {
    return INTENTS.SHOW_APPOINTMENTS;
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
