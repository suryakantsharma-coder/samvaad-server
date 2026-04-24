const { voice, llm } = require("@livekit/agents");
const { getRealtimeTools } = require("../src/agent/realtimeTools");
const { runHospitalTool } = require("../src/agent/realtimeToolHandlers");

/**
 * Build LiveKit function tools from OpenAI-style definitions, backed by runHospitalTool.
 */
function buildHospitalTools(hospitalObjectId, callerPhone) {
  const defs = getRealtimeTools();
  const tools = {};
  for (const def of defs) {
    const name = def.name;
    if (!name) continue;
    tools[name] = llm.tool({
      description: def.description || "",
      parameters: def.parameters,
      execute: async (args) => {
        return runHospitalTool(
          hospitalObjectId,
          name,
          args && typeof args === "object" ? args : {},
          { callerPhone: callerPhone || null },
        );
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
    super({
      instructions,
      tools: buildHospitalTools(hospitalObjectId, callerPhone),
    });
    this._routeUserTextThroughRealtime = routeUserTextThroughRealtime;
  }

  /**
   * LiveKit clears STT output for RealtimeModel before generateReply; we inject Sarvam text here instead.
   */
  async onUserTurnCompleted(_chatCtx, newMessage) {
    if (!this._routeUserTextThroughRealtime) return;
    const text = (newMessage && newMessage.textContent
      ? String(newMessage.textContent).trim()
      : "");
    if (process.env.SARVAM_STT_DEBUG !== "0") {
      const preview = text
        ? `"${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`
        : "(empty — agent will not reply)";
      console.log("[Sarvam STT] onUserTurnCompleted user text:", preview);
    }
    if (!text) {
      throw new voice.StopResponse();
    }
    this.session.generateReply({ userMessage: newMessage });
    throw new voice.StopResponse();
  }
}

module.exports = { HospitalVoiceAgent, buildHospitalTools };
