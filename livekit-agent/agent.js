const { voice, llm } = require("@livekit/agents");
const { getRealtimeTools } = require("../src/agent/realtimeTools");
const { runHospitalTool } = require("../src/agent/realtimeToolHandlers");
const { normalizeShortYesNoInPlace } = require("./userTranscriptNormalize");

/**
 * Build LiveKit function tools from OpenAI-style definitions, backed by runHospitalTool.
 *
 * agentRef is a mutable { current: HospitalVoiceAgent | null } box so tools can
 * reach back to the agent session after create_appointment succeeds — forcing an
 * explicit generateReply so the post-tool turn is not silent (Sarvam-STT route).
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

        // After create_appointment succeeds, Realtime sometimes stays silent post-tool.
        // Prompt section 9 already spoke WhatsApp + thanks before the tool — do not repeat it.
        if (name === "create_appointment" && result && result.ok) {
          const agent = agentRef && agentRef.current;
          if (agent) {
            const instructions =
              "create_appointment succeeded. The caller already heard (before this tool) that WhatsApp confirmation will come after the appointment is created, with thanks. " +
              "Do NOT repeat that. Say ONLY the hang-up line once in the caller's language (Hindi or Gujarati), verbatim intent:\n" +
              "Hindi: अगर आपका कोई और सवाल नहीं है तो आप कॉल काट सकते हैं। कृपया।\n" +
              "Gujarati: જો તમને બીજો કોઈ પ્રશ્ન ન હોય તો તમે કૉલ કાપી શકો છો. કૃપા કરીને.";
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
