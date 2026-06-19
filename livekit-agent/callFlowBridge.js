/**
 * OpenAI Realtime + server turn_detection skips agent.onUserTurnCompleted entirely
 * (see LiveKit AgentActivity.userTurnCompleted early return). This bridge runs
 * call-flow + emergency hangup on STT finals and when the agent speaks thank-you.
 */
const { voice } = require("@livekit/agents");
const { handleCallFlowTurn } = require("./emergencyFlow");
const { endEmergencyPhoneCall } = require("./endCall");

const LOG_TAG = "[CallFlowBridge]";

const ASK_REPEAT_OR_NOTE_RE =
  /नंबर दोबारा|नोट कर लिया|नંબર ફરી|નોંધી લીધ/i;

const EMERGENCY_THANK_YOU_RE =
  /फ़ोन करने के लिए धन्यवाद|फोन करने के लिए धन्यवाद|ફોન કરવા બદલ/i;

/** @param {unknown} item */
function extractConversationItemText(item) {
  if (!item || item.type !== "message") return null;
  if (item.role !== "user" && item.role !== "assistant") return null;
  if (typeof item.textContent === "string" && item.textContent.trim()) {
    return item.textContent.trim();
  }
  const c = item.content;
  if (!Array.isArray(c)) return null;
  const parts = [];
  for (const part of c) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      const t = part.text ?? part.transcript;
      if (typeof t === "string") parts.push(t);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/**
 * @param {string} text
 * @param {string} hospitalName
 */
function isEmergencyThankYouLine(text, hospitalName) {
  const t = String(text || "");
  if (!t) return false;
  if (EMERGENCY_THANK_YOU_RE.test(t)) return true;
  const name = String(hospitalName || "").trim();
  if (name && t.includes(name) && /धन्यवाद|આભાર/.test(t)) return true;
  return false;
}

/**
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {import("@livekit/agents").voice.AgentSession} session
 */
function shouldBlockRealtimeReply(agent) {
  const cf = agent && agent.callFlow;
  if (!cf) return false;
  return (
    cf.phase === "awaiting_language" ||
    cf.phase === "awaiting_case_type" ||
    cf.phase === "emergency" ||
    cf.phase === "emergency_ending" ||
    Boolean(cf.emergencyLlmActive)
  );
}

/**
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {import("@livekit/agents").voice.AgentSession | null | undefined} session
 */
async function pauseRealtimeAutoReply(agent, session) {
  if (!shouldBlockRealtimeReply(agent) || !session) return;
  if (typeof session.pauseReplyAuthorization === "function") {
    try {
      session.pauseReplyAuthorization();
    } catch (_) {
      /* ignore */
    }
  }
  if (typeof session.interrupt === "function") {
    try {
      await session.interrupt({ force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * @param {import("@livekit/agents").voice.AgentSession | null | undefined} session
 */
function resumeRealtimeAutoReply(session) {
  if (!session || typeof session.resumeReplyAuthorization !== "function") return;
  try {
    session.resumeReplyAuthorization();
  } catch (_) {
    /* ignore */
  }
}

/**
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {import("@livekit/agents").voice.AgentSession} session
 * @param {string} text
 */
async function runCallFlowOnUserText(agent, session, text) {
  if (!text.trim() || agent.callFlow.phase === "emergency_ending") return;

  await pauseRealtimeAutoReply(agent, session);

  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
  if (logger) {
    logger.log("call_flow_bridge_user", {
      text: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      phase: agent.callFlow.phase,
      emergencyStep: agent.callFlow.emergencyStep || null,
    });
  }
  console.log(LOG_TAG, "user transcript → call flow", {
    phase: agent.callFlow.phase,
    step: agent.callFlow.emergencyStep,
    text: text.slice(0, 80),
  });

  const handled = await handleCallFlowTurn({
    agent,
    rawUser: text,
    normalizedUser: text,
  });

  if (!handled && agent.callFlow.phase === "booking") {
    resumeRealtimeAutoReply(session);
  }
}

/**
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {import("@livekit/agents").voice.AgentSession} session
 * @param {string} text
 */
async function maybeEndCallAfterAgentThankYou(agent, session, text) {
  if (!text.trim() || agent._emergencyHangupScheduled) return;

  if (ASK_REPEAT_OR_NOTE_RE.test(text)) {
    agent.callFlow.phase = "emergency";
    agent.callFlow.emergencyStep = "awaiting_repeat_or_note";
    agent.callFlow.emergencyLlmActive = true;
    console.log(
      LOG_TAG,
      "emergency repeat/note question heard — armed for noted → hangup",
    );
    await pauseRealtimeAutoReply(agent, session);
    return;
  }

  const inEmergency =
    agent.callFlow.phase === "emergency" ||
    agent.callFlow.emergencyLlmActive ||
    agent.callFlow.emergencyStep === "awaiting_repeat_or_note";

  if (!inEmergency) return;
  if (!isEmergencyThankYouLine(text, agent.hospitalName)) return;

  agent._emergencyHangupScheduled = true;
  agent.callFlow.phase = "emergency_ending";
  agent.callFlow.emergencyStep = "done";

  const roomName =
    (agent._callRoomName && String(agent._callRoomName)) ||
    (agent.roomName && String(agent.roomName)) ||
    "";
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;

  console.log(
    LOG_TAG,
    "agent spoke emergency thank-you — invoking endEmergencyPhoneCall",
    { roomName, preview: text.slice(0, 100) },
  );
  if (logger) {
    logger.log("end_call_triggered_by_agent_speech", {
      roomName: roomName || null,
      textPreview: text.slice(0, 160),
    });
  }

  await endEmergencyPhoneCall({
    roomName,
    session,
    logger,
    reason: "emergency_thank_you_spoken",
  });
}

/**
 * Realtime fallback: LLM spoke booking thank-you without create_appointment tool schedule.
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {string} text
 */
function maybeScheduleBookingHangupAfterThankYou(agent, text) {
  if (!text.trim() || agent._emergencyHangupScheduled || agent._bookingHangupScheduled) {
    return;
  }
  if (agent.postBookingClosingInFlight) return;
  if (agent.callFlow.phase !== "booking") return;
  if (!isEmergencyThankYouLine(text, agent.hospitalName)) return;

  agent._bookingHangupScheduled = true;
  console.log(
    LOG_TAG,
    "agent spoke booking thank-you — scheduling auto hangup",
    { preview: text.slice(0, 100) },
  );
  const { scheduleAutoEndAfterBookingConfirmed } = require("./endCall");
  scheduleAutoEndAfterBookingConfirmed({ agent });
}

/**
 * @param {import("@livekit/agents").voice.AgentSession} session
 * @param {import("./agent").HospitalVoiceAgent} agent
 * @param {{ handleUserTranscript?: boolean }} [opts]
 * @returns {() => void} detach
 */
function attachCallFlowBridge(session, agent, opts = {}) {
  const handleUserTranscript = opts.handleUserTranscript !== false;
  let userBusy = false;
  let hangupBusy = false;

  /** @param {import("@livekit/agents/dist/voice/events").UserInputTranscribedEvent} ev */
  const onUserInputTranscribed = async (ev) => {
    if (!handleUserTranscript || !ev || !ev.isFinal) return;
    const text = String(ev.transcript || "").trim();
    if (!text || userBusy || agent.callFlow.phase === "emergency_ending") return;

    userBusy = true;
    try {
      agent.updateLanguageFromTranscript(text);

      if (
        agent.callFlow.phase !== "emergency" &&
        agent.callFlow.phase !== "emergency_ending"
      ) {
        try {
          const { applyTranscriptToBookingSlots } = require("./bookingSlotCapture");
          applyTranscriptToBookingSlots(agent.callBookingSlots, text);
        } catch (_) {
          /* ignore */
        }
        if (
          agent.callFlow.phase === "booking" ||
          agent.callFlow.phase === "awaiting_language" ||
          agent.callFlow.phase === "awaiting_case_type"
        ) {
          try {
            const {
              maybeCaptureVisitReasonFromTranscript,
            } = require("./callBookingSlots");
            maybeCaptureVisitReasonFromTranscript(agent.callBookingSlots, text);
          } catch (_) {
            /* ignore */
          }
        }
      }

      await runCallFlowOnUserText(agent, session, text);
    } catch (err) {
      console.error(
        LOG_TAG,
        "user transcript handler failed:",
        err && err.message ? err.message : err,
      );
    } finally {
      userBusy = false;
    }
  };

  /** @param {{ item?: import("@livekit/agents").llm.ChatMessage }} ev */
  const onConversationItemAdded = async (ev) => {
    if (!ev || !ev.item || ev.item.role !== "assistant") return;
    const text = extractConversationItemText(ev.item);
    if (!text || hangupBusy || agent._emergencyHangupScheduled) return;

    hangupBusy = true;
    try {
      await maybeEndCallAfterAgentThankYou(agent, session, text);
      maybeScheduleBookingHangupAfterThankYou(agent, text);
    } catch (err) {
      console.error(
        LOG_TAG,
        "agent message handler failed:",
        err && err.message ? err.message : err,
      );
    } finally {
      hangupBusy = false;
    }
  };

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, onUserInputTranscribed);
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onConversationItemAdded);

  console.log(
    LOG_TAG,
    "attached",
    handleUserTranscript
      ? "(Realtime+Sarvam: user STT + agent thank-you hangup)"
      : "(agent thank-you hangup only)",
  );

  return () => {
    session.off(voice.AgentSessionEventTypes.UserInputTranscribed, onUserInputTranscribed);
    session.off(voice.AgentSessionEventTypes.ConversationItemAdded, onConversationItemAdded);
  };
}

module.exports = {
  attachCallFlowBridge,
  isEmergencyThankYouLine,
  runCallFlowOnUserText,
  maybeEndCallAfterAgentThankYou,
};
