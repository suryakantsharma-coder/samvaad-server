const {
  isEmergencyRepeatRequest,
  isEmergencyHangUpRequest,
  isEmergencyBookingRequest,
} = require("./bookingSlotCapture");
const {
  getEmergencyTwoOptionsLine,
  getEmergencyNoBookingLine,
  getEmergencyThankYouLine,
} = require("./preferredLanguage");
const { speakEmergencyNumberDigitByDigit, getEmergencyDigitGapMs } = require("./emergencyNumberSpeech");
const { scheduleAutoEndAfterBookingConfirmed } = require("./endPhoneCall");

const LOG_TAG = "[EmergencyFlow]";

/**
 * Same end-call entry point as post-booking confirmation (speech already played out).
 * @param {import('./agent').HospitalVoiceAgent} agent
 */
function scheduleEmergencyGoodbyeEndCall(agent) {
  console.log(LOG_TAG, "scheduling end call via scheduleAutoEndAfterBookingConfirmed");
  scheduleAutoEndAfterBookingConfirmed({
    agent,
    speechAlreadyComplete: true,
    purpose: "emergency_goodbye",
  });
}

/**
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {string} instructions
 */
async function speakInstructions(session, instructions) {
  const handle = session.generateReply({
    toolChoice: "none",
    allowInterruptions: false,
    instructions,
  });
  if (handle && typeof handle.waitForPlayout === "function") {
    await handle.waitForPlayout();
  }
}

/**
 * Speak exactly one line via TTS (no LLM paraphrase). Falls back to generateReply.
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {string} text
 */
async function speakExactLine(session, text) {
  const line = String(text || "").trim();
  if (!line || !session) return;
  try {
    const handle = session.say(line, {
      addToChatCtx: false,
      allowInterruptions: false,
    });
    if (handle && typeof handle.waitForPlayout === "function") {
      await handle.waitForPlayout();
    }
    return;
  } catch (_) {
    /* OpenAI Realtime-only pipeline — no external TTS */
  }
  await speakInstructions(
    session,
    `URGENT_ONE_TURN — Speak EXACTLY this one line and stop. Do not add any other words:\n"${line}"`,
  );
}

/**
 * Emergency-only multi-step speech: intro → digits (1s gap) → two options.
 * @param {{
 *   agent: import('./agent').HospitalVoiceAgent,
 *   session: import('@livekit/agents').voice.AgentSession,
 *   slots: import('./callBookingSlots').CallBookingSlots,
 *   rawBefore: string,
 *   textAfter: string,
 *   preferredLanguage: 'hi'|'gu',
 *   logger?: { log?: (type: string, data?: object) => void } | null,
 * }} p
 */
async function handleEmergencyUserTurn(p) {
  const { agent, session, slots, rawBefore, textAfter, preferredLanguage, logger } =
    p;
  const callerLang = preferredLanguage === "gu" ? "gu" : "hi";
  const langLabel = callerLang === "gu" ? "Gujarati" : "Hindi";
  const wantsRepeat =
    isEmergencyRepeatRequest(rawBefore) || isEmergencyRepeatRequest(textAfter);
  const wantsHangUp =
    isEmergencyHangUpRequest(rawBefore, slots) ||
    isEmergencyHangUpRequest(textAfter, slots);
  const wantsBooking =
    isEmergencyBookingRequest(rawBefore) ||
    isEmergencyBookingRequest(textAfter);
  const isFirstAnnounce = !slots.emergencyPhase;
  const emergencyNumber = agent._hospitalEmergencyNumber;
  const hospitalName = agent._hospitalName;

  if (logger) {
    logger.log("generate_reply", {
      purpose: "emergency_flow",
      lang: preferredLanguage,
      wantsRepeat,
      wantsHangUp,
      wantsBooking,
      isFirstAnnounce,
      emergencyPhase: slots.emergencyPhase || null,
      caseType: slots.caseType || null,
    });
  }

  if (slots.emergencyPhase === "done") {
    console.log(LOG_TAG, "emergency already complete — re-scheduling end call only");
    scheduleEmergencyGoodbyeEndCall(agent);
    return;
  }

  if (wantsHangUp) {
    slots.emergencyPhase = "done";
    slots.caseType = "emergency";
    agent.postBookingClosingInFlight = true;
    const thankYou = getEmergencyThankYouLine(callerLang, hospitalName);
    if (logger) {
      logger.log("generate_reply", {
        purpose: "emergency_thank_you",
        lang: preferredLanguage,
        line: thankYou,
      });
    }
    console.log(LOG_TAG, "caller noted number — speaking thank-you:", thankYou);
    await speakExactLine(session, thankYou);
    console.log(LOG_TAG, "thank-you message completed");
    if (logger) {
      logger.log("emergency_thank_you_complete", {
        lang: preferredLanguage,
        line: thankYou,
      });
    }
    scheduleEmergencyGoodbyeEndCall(agent);
    return;
  }

  if (slots.emergencyPhase === "done") return;

  if (wantsBooking) {
    await speakInstructions(
      session,
      `EMERGENCY — Say in ${langLabel} only: "${getEmergencyNoBookingLine(callerLang)}" Do NOT speak any phone number.`,
    );
  } else if (isFirstAnnounce) {
    await speakInstructions(
      session,
      `EMERGENCY — Say in ${langLabel} only: tell the caller to go to the emergency department immediately. Do NOT speak any phone number — the system will play it digit by digit in English next.`,
    );
  }

  const shouldPlayNumber =
    Boolean(emergencyNumber) && (isFirstAnnounce || wantsRepeat || wantsBooking);

  if (shouldPlayNumber) {
    if (logger) {
      logger.log("emergency_number_digits", {
        digitCount: String(emergencyNumber).replace(/\D/g, "").length,
        gapMs: getEmergencyDigitGapMs(),
      });
    }
    await speakEmergencyNumberDigitByDigit(
      session,
      emergencyNumber,
      () => slots.emergencyPhase !== "done",
    );
  }

  if (slots.emergencyPhase === "done") return;

  await speakInstructions(
    session,
    `EMERGENCY — Say in ${langLabel} only: "${getEmergencyTwoOptionsLine(callerLang)}"`,
  );

  if (slots.emergencyPhase === "done") return;

  if (!slots.emergencyPhase) {
    slots.emergencyPhase = "await_choice";
  }
}

module.exports = { handleEmergencyUserTurn };
