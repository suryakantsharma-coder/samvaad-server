const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { ServerOptions, cli, defineAgent, voice } = require("@livekit/agents");
const openai = require("@livekit/agents-plugin-openai");
const { BackgroundVoiceCancellation } = require("@livekit/noise-cancellation-node");
const { HospitalVoiceAgent } = require("./agent");
const { ensureMongoConnected } = require("./dbConnect");
const HospitalModel = require("../src/models/hospital.model");
const { getHospitalInstructions } = require("../src/agent/hospitalPrompt");

const API_PORT = parseInt(process.env.PORT, 10) || 3000;
const HOSPITALS_API_URL =
  process.env.HOSPITALS_API_URL ||
  `http://127.0.0.1:${API_PORT}/api/hospitals`;
const AGENT_NAME = process.env.AGENT_NAME || "phone-agent";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini-2025-12-15";

async function resolveHospitalName(roomName) {
  const prefix = "hospital-";
  if (!roomName || !roomName.startsWith(prefix)) return "the hospital";
  const hospitalId = roomName.slice(prefix.length);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(HOSPITALS_API_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(
        "[LiveKit Agent] /hospitals request failed:",
        res.status,
        res.statusText,
      );
      return "the hospital";
    }

    const data = await res.json();
    const hospitals = (data && data.data && data.data.hospitals) || [];
    const match = hospitals.find((h) => h.id === hospitalId);
    if (!match) {
      console.warn(
        "[LiveKit Agent] No hospital found for id from roomName:",
        hospitalId,
      );
      return "the hospital";
    }
    return match.name || "the hospital";
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[LiveKit Agent] Failed to fetch hospitals:", msg);
    if (err && err.name === "AbortError") {
      console.warn("[LiveKit Agent] Hospitals API timed out (5s), using fallback");
    }
    return "the hospital";
  }
}

function parseHospitalIdFromRoom(roomName) {
  const prefix = "hospital-";
  if (!roomName || !String(roomName).startsWith(prefix)) return null;
  const id = String(roomName).slice(prefix.length).trim();
  if (!mongoose.isValidObjectId(id)) return null;
  return id;
}

const agentDef = defineAgent({
  entry: async (ctx) => {
    console.log("[LiveKit Agent] JOB RECEIVED — call connected, agent starting...");
    try {
      const roomName = (ctx.job && ctx.job.room && ctx.job.room.name)
        ? String(ctx.job.room.name)
        : (ctx.room && ctx.room.name ? String(ctx.room.name) : "");
      console.log("[LiveKit Agent] Job started. Room:", roomName || "(unknown)");

      await ensureMongoConnected();

      const hospitalId = parseHospitalIdFromRoom(roomName);
      if (!hospitalId) {
        throw new Error(
          `[LiveKit Agent] Invalid room name "${roomName}". Expected hospital-{mongoObjectId}.`,
        );
      }

      const hospital = await HospitalModel.findById(hospitalId).lean();
      if (!hospital) {
        throw new Error(`[LiveKit Agent] Hospital not found: ${hospitalId}`);
      }

      const hospitalNameFallback = await resolveHospitalName(roomName);
      const instructions = await getHospitalInstructions(hospital, null);
      console.log(
        "[LiveKit Agent] Loaded hospital:",
        hospital.name,
        "(",
        hospitalNameFallback,
        ")",
      );

      const callerPhone =
        (ctx.job && ctx.job.metadata && ctx.job.metadata.callerPhone) ||
        (ctx.job && ctx.job.metadata && ctx.job.metadata.phone) ||
        null;

      const session = new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          model: OPENAI_REALTIME_MODEL,
          voice: "coral",
          toolChoice: "auto",
          turnDetection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        }),
      });

      await session.start({
        agent: new HospitalVoiceAgent({
          instructions,
          hospitalObjectId: hospital._id,
          callerPhone,
        }),
        room: ctx.room,
        inputOptions: {
          noiseCancellation: BackgroundVoiceCancellation(),
        },
      });

      await ctx.connect();

      const handle = session.generateReply({
        instructions: `Start the call: Greet in Hindi - "नमस्ते, मैं नेहा बोल रही हूँ। मैं ${hospital.name} से हूँ।" Then ask in Hindi: "क्या आप हिंदी में बात करेंगे या गुजराती में?"`,
      });
      await handle.waitForPlayout();

      console.log(
        "[LiveKit Agent] Initial greeting sent for room:",
        roomName,
        "hospital:",
        hospital.name,
      );
    } catch (err) {
      console.error(
        "[LiveKit Agent] Entry error:",
        err && err.message ? err.message : err,
      );
      throw err;
    }
  },
});

module.exports = agentDef;

console.log("[LiveKit Agent] Starting worker, agent name:", AGENT_NAME);
console.log(
  "[LiveKit Agent] Ensure LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY, MONGODB_URI are set in .env",
);
cli.runApp(
  new ServerOptions({
    agent: __filename,
    agentName: AGENT_NAME,
  }),
);
