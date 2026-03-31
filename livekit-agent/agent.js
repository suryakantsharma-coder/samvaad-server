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
  constructor({ instructions, hospitalObjectId, callerPhone }) {
    super({
      instructions,
      tools: buildHospitalTools(hospitalObjectId, callerPhone),
    });
  }
}

module.exports = { HospitalVoiceAgent, buildHospitalTools };
