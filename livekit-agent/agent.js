const { voice, llm } = require("@livekit/agents");
const { getRealtimeTools } = require("../src/agent/realtimeTools");
const { runHospitalTool } = require("../src/agent/realtimeToolHandlers");
const { normalizeShortYesNoInPlace } = require("./userTranscriptNormalize");

/**
 * Build LiveKit function tools from OpenAI-style definitions, backed by runHospitalTool.
 *
 * agentRef is a mutable { current: HospitalVoiceAgent | null } box so tools can
 * reach back to the agent session after create_appointment succeeds — forcing an
 * explicit generateReply that proactively speaks the booking status.  Without this,
 * the Sarvam-STT route's post-tool reply produces messageCount:0 (silent).
 */
function buildHospitalTools(hospitalObjectId, callerPhone, agentRef) {
  const defs = getRealtimeTools();
  const tools = {};
  // Shared mutable ref so set_calling_phone can update the phone for the whole session.
  const sessionPhoneRef = { value: null };
  for (const def of defs) {
    const name = def.name;
    if (!name) continue;
    tools[name] = llm.tool({
      description: def.description || "",
      parameters: def.parameters,
      execute: async (args) => {
        const result = await runHospitalTool(
          hospitalObjectId,
          name,
          args && typeof args === "object" ? args : {},
          { callerPhone: callerPhone || null, sessionPhoneRef },
        );

        // After a successful booking, proactively speak the booking status.
        // We use a short timeout so the LiveKit framework finishes processing
        // the tool result before we kick off a new generateReply.
        if (name === "create_appointment" && result && result.ok) {
          const agent = agentRef && agentRef.current;
          if (agent) {
            const msgHi = result.messageHindi || "";
            const msgGu = result.messageGujarati || "";
            const instructions =
              "The appointment is now booked. Speak ONE of the lines below " +
              "(choose the caller's language — Hindi or Gujarati), then add " +
              "the hang-up line. Do NOT change the wording, do NOT repeat the " +
              "full booking summary again:\n" +
              `Hindi: ${msgHi}\n` +
              `Gujarati: ${msgGu}`;
            setTimeout(() => {
              try {
                agent.session.generateReply({ instructions });
              } catch (err) {
                console.error(
                  "[Agent] post-booking generateReply error:",
                  err && err.message ? err.message : err,
                );
              }
            }, 120);
          }
        }

        return result;
      },
    });
  }
  return tools;
}

class HospitalVoiceAgent extends voice.Agent {
  constructor({
    instructions,
    hospitalObjectId,
    callerPhone,
    /** When true, user speech is transcribed by Sarvam and sent as text into OpenAI Realtime (see main.js). */
    routeUserTextThroughRealtime = false,
  }) {
    // agentRef is filled right after super() so tools can reach this.session.
    const agentRef = { current: null };
    super({
      instructions,
      tools: buildHospitalTools(hospitalObjectId, callerPhone, agentRef),
    });
    agentRef.current = this;
    this._routeUserTextThroughRealtime = routeUserTextThroughRealtime;
  }

  /**
   * LiveKit clears STT output for RealtimeModel before generateReply; we inject Sarvam text here instead.
   */
  async onUserTurnCompleted(_chatCtx, newMessage) {
    // Make "haa", "ha", "h" etc. unambiguous to the model (STT is often 2–3 letters).
    normalizeShortYesNoInPlace(newMessage);
    if (!this._routeUserTextThroughRealtime) return;
    const text = (newMessage && newMessage.textContent
      ? String(newMessage.textContent).trim()
      : "");
    if (!text) {
      throw new voice.StopResponse();
    }
    this.session.generateReply({ userMessage: newMessage });
    throw new voice.StopResponse();
  }
}

module.exports = { HospitalVoiceAgent, buildHospitalTools };
