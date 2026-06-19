/**
 * Emergency vs normal case flow for the hospital voice agent.
 * After language lock (Hindi / Gujarati only), caller is asked case type;
 * emergency path reads DB number digit-by-digit in English, then repeat/note loop.
 */

/** @typedef {'awaiting_language'|'awaiting_case_type'|'emergency'|'emergency_ending'|'booking'} CallFlowPhase */

const DIGIT_WORDS_EN = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

const EMERGENCY_RE =
  /\b(emergency|emerjency|imergency|urgent|aapatkal|aapat|आपात|इमरजेंसी|इमर्जेंसी|एमर्जेंसी|एमर्जन्सी|इमर्जन्सी)\b|ઇમરજન્સી|ઈમરજન્સી|આપત્તિ|आपातकाल|emergency\s*case|इमरजेंसी\s*केस/i;

const NORMAL_RE =
  /\b(normal|routine|regular|appointment|booking|opd)\b|सामान्य|नॉर्मल|रूटीन|अपॉइंटमेंट|बुकिंग|સામાન્ય|નોર્મલ|રૂટીન|એપોઇન્ટમેન્ટ|normal\s*case|सामान्य\s*केस/i;

const NOTED_RE =
  /note|not\s*kar|नोट|नोंध|likh|लिख|le liya|ले लिया|kar liya|kar liya hai|कर लिया|likh liya|लिख लिया|note kiya|not kiya|ho gaya|mil gaya|samajh|જ લીધ|નોંધ|લખ/i;

const REPEAT_RE =
  /repeat|dubara|dohbara|dobara|phir se|फिर से|दोबारा|farithi|ફરી|bol do|boliye|bolo|बोल|repeat kar|farithi bol/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function extractEmergencyDigits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return [];
  return digits.split("");
}

/** Emergency digits are always spoken in English (nine, eight, seven…). */
function digitToWord(digitChar) {
  const n = Number(digitChar);
  if (Number.isFinite(n) && n >= 0 && n <= 9) return DIGIT_WORDS_EN[n];
  return digitChar;
}

/** @param {'hi'|'gu'} lang */
function langLabel(lang) {
  return lang === "gu" ? "Gujarati" : "Hindi";
}

/** @param {'hi'|'gu'} lang */
function buildCaseTypeQuestion(lang) {
  if (lang === "gu") {
    return "કૃપા કરીને જણાવો — આ કઈ રીતનો કેસ છે: ઇમરજન્સી કે સામાન્ય?";
  }
  return "कृपया बताइए — यह इमरजेंसी केस है या सामान्य केस?";
}

/** @param {'hi'|'gu'} lang */
function getAskRepeatOrNotedLine(lang) {
  if (lang === "gu") {
    return "શું હું નંબર ફરી બોલું, કે તમે નોંધી લીધું છે?";
  }
  return "क्या मैं नंबर दोबारा बोलूँ, या आपने नोट कर लिया है?";
}

/**
 * @param {'hi'|'gu'} lang
 * @param {string} hospitalName
 */
function getEmergencyIntro(lang, hospitalName) {
  const name = hospitalName || "अस्पताल";
  if (lang === "gu") {
    return `કૃપા કરીને ધ્યાનથી સાંભળો. ${name} નો ઇમરજન્સી નંબર છે:`;
  }
  return `कृपया ध्यान से सुनिए। ${name} का इमरजेंसी नंबर है:`;
}

/**
 * @param {'hi'|'gu'} lang
 * @param {string} hospitalName
 */
function getEmergencyThankYou(lang, hospitalName) {
  const name = hospitalName || "अस्पताल";
  if (lang === "gu") {
    return `${name} માં ફોન કરવા બદલ આભાર.`;
  }
  return `${name} में फ़ोन करने के लिए धन्यवाद।`;
}

/**
 * @param {string} text
 * @returns {'emergency'|'normal'|null}
 */
function detectCaseType(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 200) return null;
  if (EMERGENCY_RE.test(s)) return "emergency";
  if (NORMAL_RE.test(s)) return "normal";
  return null;
}

/**
 * @param {string} rawUser
 * @param {string} normalizedUser
 * @returns {'noted'|'repeat'|null}
 */
function detectRepeatOrNoted(rawUser, normalizedUser) {
  const s = String(rawUser || "").trim();
  if (!s) return null;
  if (NOTED_RE.test(s)) return "noted";
  if (REPEAT_RE.test(s)) return "repeat";

  const { isAffirmativeTurn, isNegationTurn } = require("./userTranscriptNormalize");
  if (isNegationTurn(rawUser, normalizedUser)) return "repeat";
  if (isAffirmativeTurn(rawUser, normalizedUser)) return "noted";
  return null;
}

/**
 * @param {import("@livekit/agents").voice.AgentSession | null | undefined} session
 * @param {string} instructions
 */
async function speakInstructions(session, instructions) {
  if (!session || typeof session.generateReply !== "function") return;
  if (typeof session.interrupt === "function") {
    try {
      await session.interrupt({ force: true });
    } catch (_) {
      /* ignore */
    }
  }
  const handle = session.generateReply({
    toolChoice: "none",
    instructions,
  });
  if (handle && typeof handle.waitForPlayout === "function") {
    await handle.waitForPlayout();
  }
}

/**
 * @param {import("@livekit/agents").voice.AgentSession | null | undefined} session
 * @param {string[]} digits
 * @param {number} [gapMs]
 */
async function speakDigitsWithDelay(session, digits, gapMs = 1000) {
  if (!digits.length) return;
  for (let i = 0; i < digits.length; i += 1) {
    const word = digitToWord(digits[i]);
    await speakInstructions(
      session,
      `Say ONLY this single English digit word, nothing else — no greeting, no extra words: "${word}"`,
    );
    if (i < digits.length - 1) {
      await sleep(gapMs);
    }
  }
}

/**
 * @param {{
 *   session: import("@livekit/agents").voice.AgentSession | null | undefined,
 *   lang: 'hi'|'gu',
 *   hospitalName: string,
 *   emergencyNumber: string,
 *   gapMs?: number,
 * }} p
 */
async function runEmergencyDigitAnnouncement(p) {
  const { session, lang, hospitalName, emergencyNumber, gapMs = 1000 } = p;
  const digits = extractEmergencyDigits(emergencyNumber);
  if (!digits.length) {
    await speakInstructions(
      session,
      `In ${langLabel(lang)}: apologize briefly — emergency number is not configured — and ask them to visit the hospital reception immediately. Do NOT offer appointment booking.`,
    );
    return false;
  }
  await speakInstructions(
    session,
    `In ${langLabel(lang)}, say exactly this line and nothing else: "${getEmergencyIntro(lang, hospitalName)}"`,
  );
  await speakDigitsWithDelay(session, digits, gapMs);
  return true;
}

/**
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {import("@livekit/agents").voice.AgentSession | null | undefined} session
 * @param {(event: string, extra?: object) => void} log
 */
async function endEmergencyCall(agent, session, log) {
  agent.callFlow.phase = "emergency_ending";
  agent.callFlow.emergencyStep = "done";
  agent._emergencyHangupScheduled = true;
  log("call_flow", { step: "emergency_disconnect_scheduled" });
  console.log("[EndCall] endEmergencyCall invoked — scheduling room delete after thank-you idle");

  const roomName =
    (agent._callRoomName && String(agent._callRoomName)) ||
    (agent.roomName && String(agent.roomName)) ||
    "";
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  const { endEmergencyPhoneCall } = require("./endCall");
  const result = await endEmergencyPhoneCall({
    roomName,
    session,
    logger,
    reason: "emergency_flow_complete",
  });
  log("call_disconnect", result);
}

/**
 * @param {{
 *   agent: import("./agent").HospitalVoiceAgent,
 *   rawUser: string,
 *   normalizedUser: string,
 * }} p
 * @returns {Promise<boolean>} true if this turn was fully handled (caller should StopResponse)
 */
async function handleCallFlowTurn(p) {
  const { agent, rawUser, normalizedUser } = p;
  if (!agent || !agent.callFlow) return false;
  if (agent.callFlow.phase === "emergency_ending") return true;

  const lang = agent.preferredLanguage === "gu" ? "gu" : "hi";
  const session = agent.session;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  const log = (event, extra = {}) => {
    if (logger) logger.log(event, { ...extra, callFlowPhase: agent.callFlow.phase });
  };

  if (
    agent.callFlow.phase === "awaiting_language" &&
    agent.preferredLanguageLocked
  ) {
    agent.callFlow.phase = "awaiting_case_type";
    log("call_flow", { step: "ask_case_type", lang });
    await speakInstructions(
      session,
      `You are Neha (female receptionist). The caller chose ${langLabel(lang)}. ` +
        `Say exactly ONE short question in ${langLabel(lang)} and nothing else — do NOT ask about symptoms, doctors, or appointments yet: ` +
        `"${buildCaseTypeQuestion(lang)}"`,
    );
    return true;
  }

  if (agent.callFlow.phase === "awaiting_case_type") {
    const caseType = detectCaseType(rawUser || normalizedUser);
    if (!caseType) {
      await speakInstructions(
        session,
        `In ${langLabel(lang)}, politely ask again — emergency case or normal case? One short line only: "${buildCaseTypeQuestion(lang)}"`,
      );
      return true;
    }

    if (caseType === "normal") {
      agent.callFlow.phase = "booking";
      log("call_flow", { step: "normal_booking", lang });
      return false;
    }

    agent.callFlow.phase = "emergency";
    agent.callFlow.emergencyStep = "awaiting_repeat_or_note";
    log("call_flow", { step: "emergency_start", lang });

    if (session && typeof session.pauseReplyAuthorization === "function") {
      try {
        session.pauseReplyAuthorization();
      } catch (_) {
        /* ignore */
      }
    }

    const hasDigits = await runEmergencyDigitAnnouncement({
      session,
      lang,
      hospitalName: agent.hospitalName,
      emergencyNumber: agent.emergencyNumber,
    });
    if (hasDigits) {
      await sleep(400);
      await speakInstructions(
        session,
        `In ${langLabel(lang)}, say exactly: "${getAskRepeatOrNotedLine(lang)}"`,
      );
    }
    return true;
  }

  if (
    agent.callFlow.phase === "emergency" &&
    agent.callFlow.emergencyStep === "awaiting_repeat_or_note"
  ) {
    const answer = detectRepeatOrNoted(rawUser, normalizedUser);

    if (answer === "noted") {
      const thankYou = getEmergencyThankYou(lang, agent.hospitalName);
      await speakInstructions(
        session,
        `In ${langLabel(lang)}, say exactly this thank-you line and nothing else: "${thankYou}"`,
      );
      log("call_flow", { step: "emergency_thank_you", lang });
      await endEmergencyCall(agent, session, log);
      return true;
    }

    const digits = extractEmergencyDigits(agent.emergencyNumber);
    if (answer === "repeat" || answer === null) {
      if (digits.length) {
        await speakDigitsWithDelay(session, digits, 1000);
        await sleep(400);
      }
      await speakInstructions(
        session,
        `In ${langLabel(lang)}, say exactly: "${getAskRepeatOrNotedLine(lang)}"`,
      );
      return true;
    }

    return true;
  }

  if (agent.callFlow.phase === "emergency") return true;

  return false;
}

module.exports = {
  sleep,
  extractEmergencyDigits,
  digitToWord,
  buildCaseTypeQuestion,
  getAskRepeatOrNotedLine,
  detectCaseType,
  detectRepeatOrNoted,
  getEmergencyIntro,
  getEmergencyThankYou,
  speakDigitsWithDelay,
  runEmergencyDigitAnnouncement,
  endEmergencyCall,
  handleCallFlowTurn,
};
