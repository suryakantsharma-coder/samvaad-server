const {
  isEmergencyRepeatRequest,
  isEmergencyHangUpRequest,
  isEmergencyBookingRequest,
} = require("./bookingSlotCapture");
const {
  getEmergencyTwoOptionsLine,
  getEmergencyNoBookingLine,
  getEmergencyGoodbyeLine,
} = require("./preferredLanguage");
const { speakEmergencyNumberDigitByDigit, getEmergencyDigitGapMs } = require("./emergencyNumberSpeech");
const { scheduleAutoEndCall } = require("./endPhoneCall");

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
    isEmergencyHangUpRequest(rawBefore) || isEmergencyHangUpRequest(textAfter);
  const wantsBooking =
    isEmergencyBookingRequest(rawBefore) ||
    isEmergencyBookingRequest(textAfter);
  const isFirstAnnounce = !slots.emergencyPhase;
  const emergencyNumber = agent._hospitalEmergencyNumber;

  if (logger) {
    logger.log("generate_reply", {
      purpose: "emergency_flow",
      lang: preferredLanguage,
      wantsRepeat,
      wantsHangUp,
      wantsBooking,
      isFirstAnnounce,
    });
  }

  if (wantsHangUp) {
    slots.emergencyPhase = "done";
    await speakInstructions(
      session,
      `EMERGENCY — Say in ${langLabel} only: "${getEmergencyGoodbyeLine(callerLang)}"`,
    );
    scheduleAutoEndCall({ agent, purpose: "emergency_goodbye" });
    return;
  }

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
    await speakEmergencyNumberDigitByDigit(session, emergencyNumber);
  }

  await speakInstructions(
    session,
    `EMERGENCY — Say in ${langLabel} only: "${getEmergencyTwoOptionsLine(callerLang)}"`,
  );

  if (!slots.emergencyPhase) {
    slots.emergencyPhase = "await_choice";
  }
}

module.exports = { handleEmergencyUserTurn };
