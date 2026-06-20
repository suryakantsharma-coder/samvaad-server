const { voice } = require("@livekit/agents");
const { getThankYouLine } = require("./preferredLanguage");
const {
  isAutoEndAfterEmergencyEnabled,
  scheduleAutoEndAfterEmergencyNoted,
} = require("./endPhoneCall");
const {
  didCallerConfirmEmergencyNoted,
  isEmergencyFlowActive,
} = require("./callBookingSlots");

const LOG_TAG = "[EmergencyEnd]";

/** Agent asked repeat-or-noted after reading the emergency number. */
const EMERGENCY_REPEAT_NOTE_QUESTION_RE =
  /(?:note\s*kar|नोट\s*कर|નોંધ|dobara\s*bol|दोबारा\s*बोल|फिर\s*से\s*बोल|repeat\s*the\s*number|number\s*again|नंबर\s*दोबार)/i;

const EMERGENCY_THANK_YOU_RE =
  /(?:धन्यवाद|dhanyawad|dhanyavad|આભાર|thank\s*you\s*for\s*calling|कॉल\s*करने\s*के\s*लिए|ફોન\s*કરવા\s*બદલ)/i;

function extractConversationItemText(item) {
  if (!item) return "";
  if (typeof item.textContent === "string") return item.textContent.trim();
  if (Array.isArray(item.content)) {
    return item.content
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return c;
        if (typeof c.text === "string") return c.text;
        if (typeof c.transcript === "string") return c.transcript;
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * @param {string} text
 * @param {string | null | undefined} hospitalName
 */
function isEmergencyThankYouLine(text, hospitalName) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (EMERGENCY_THANK_YOU_RE.test(t)) return true;
  const name = String(hospitalName || "").trim();
  if (!name) return false;
  for (const lang of ["hi", "gu", "en"]) {
    const line = getThankYouLine(lang, name);
    if (line && t.includes(line.replace(/[।.!?]+$/, "").slice(0, 24))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {import('./agent').HospitalVoiceAgent | null | undefined} agent
 * @param {string} text
 */
function maybeArmEmergencyFlowFromAgentSpeech(agent, text) {
  if (!agent || !text.trim()) return;
  if (!EMERGENCY_REPEAT_NOTE_QUESTION_RE.test(text)) return;
  agent._emergencyFlowArmed = true;
  const slots = agent.callBookingSlots;
  if (slots && !slots.caseType) {
    slots.caseType = "emergency";
  }
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
  if (logger) {
    logger.log("emergency_flow_armed", {
      source: "agent_repeat_note_question",
    });
  }
  console.log(LOG_TAG, "emergency flow armed — agent asked repeat/note question");
}

/**
 * @param {import('./agent').HospitalVoiceAgent} agent
 * @param {string} reason
 * @param {Record<string, unknown>} [extra]
 */
function scheduleEmergencyCallEnd(agent, reason, extra) {
  if (!agent || agent.autoEndCallStarted || !isAutoEndAfterEmergencyEnabled()) {
    return;
  }
  const slots = agent.callBookingSlots || {};
  slots.emergencyNotedConfirmed = true;
  agent.autoEndCallStarted = true;

  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
  if (logger) {
    logger.log("emergency_end_scheduled", {
      reason,
      ...(extra || {}),
    });
  }
  console.log(LOG_TAG, "scheduling call end —", reason);
  scheduleAutoEndAfterEmergencyNoted({ agent });
}

/**
 * @param {import('./agent').HospitalVoiceAgent | null | undefined} agent
 * @param {string} text
 */
function maybeScheduleEmergencyEndFromAgentThankYou(agent, text) {
  if (!agent || !text.trim() || agent.autoEndCallStarted) return;
  if (!isAutoEndAfterEmergencyEnabled()) return;

  const slots = agent.callBookingSlots || {};
  const inEmergency =
    isEmergencyFlowActive(slots) || Boolean(agent._emergencyFlowArmed);
  if (!inEmergency) return;

  const hospitalName =
    agent._hospital && agent._hospital.name
      ? String(agent._hospital.name)
      : "";
  if (!isEmergencyThankYouLine(text, hospitalName)) return;

  scheduleEmergencyCallEnd(agent, "agent_thank_you_spoken", {
    textPreview: text.slice(0, 120),
  });
}

/**
 * Caller STT path — noted confirmation or short yes after emergency is armed.
 * @param {import('./agent').HospitalVoiceAgent} agent
 * @param {string} rawText
 */
function maybeScheduleEmergencyEndFromCallerNoted(agent, rawText) {
  if (!agent || agent.autoEndCallStarted || !isAutoEndAfterEmergencyEnabled()) {
    return;
  }
  const slots = agent.callBookingSlots || {};
  const noted = didCallerConfirmEmergencyNoted(slots, rawText, {
    flowArmed: Boolean(agent._emergencyFlowArmed),
  });
  if (!noted) return;

  scheduleEmergencyCallEnd(agent, "caller_noted_confirmed", {
    userText: rawText.length > 120 ? `${rawText.slice(0, 120)}…` : rawText,
    lang: agent.preferredLanguage,
  });
}

/**
 * Listen for agent assistant messages to arm emergency flow and cut after thank-you.
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {import('./agent').HospitalVoiceAgent} agent
 */
function attachEmergencyCallEndBridge(session, agent) {
  if (!session || !agent) return () => {};

  const onConversationItemAdded = (ev) => {
    if (!ev || !ev.item || ev.item.role !== "assistant") return;
    const text = extractConversationItemText(ev.item);
    if (!text) return;
    try {
      maybeArmEmergencyFlowFromAgentSpeech(agent, text);
      maybeScheduleEmergencyEndFromAgentThankYou(agent, text);
    } catch (err) {
      console.warn(
        LOG_TAG,
        "ConversationItemAdded handler failed:",
        err && err.message ? err.message : err,
      );
    }
  };

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onConversationItemAdded);

  return () => {
    session.off(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      onConversationItemAdded,
    );
  };
}

module.exports = {
  isEmergencyThankYouLine,
  maybeArmEmergencyFlowFromAgentSpeech,
  maybeScheduleEmergencyEndFromAgentThankYou,
  maybeScheduleEmergencyEndFromCallerNoted,
  scheduleEmergencyCallEnd,
  attachEmergencyCallEndBridge,
};
