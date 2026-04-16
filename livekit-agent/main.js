const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { ServerOptions, cli, defineAgent, voice } = require("@livekit/agents");
const openai = require("@livekit/agents-plugin-openai");
const {
  BackgroundVoiceCancellation,
} = require("@livekit/noise-cancellation-node");
const { HospitalVoiceAgent } = require("./agent");
const { ensureMongoConnected } = require("./dbConnect");
const HospitalModel = require("../src/models/hospital.model");
const { getHospitalInstructions } = require("../src/agent/hospitalPrompt");
const { runPostCallPipeline } = require("./postCallPipeline");
const { resolveCallerPhone } = require("./resolveCallerPhone");

const AGENT_NAME = process.env.AGENT_NAME || "phone-agent";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini-2025-12-15";

function parseHospitalIdFromRoom(roomName) {
  const prefix = "hospital-";
  if (!roomName || !String(roomName).startsWith(prefix)) return null;
  const id = String(roomName).slice(prefix.length).trim();
  if (!mongoose.isValidObjectId(id)) return null;
  return id;
}

const agentDef = defineAgent({
  entry: async (ctx) => {
    console.log(
      "[LiveKit Agent] JOB RECEIVED — call connected, agent starting...",
    );
    try {
      const roomName =
        ctx.job && ctx.job.room && ctx.job.room.name
          ? String(ctx.job.room.name)
          : ctx.room && ctx.room.name
            ? String(ctx.room.name)
            : "";
      console.log(
        "[LiveKit Agent] Job started. Room:",
        roomName || "(unknown)",
      );

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

      await ctx.connect();

      const callerPhone = await resolveCallerPhone(ctx);
      const sessionPhoneRef = { value: callerPhone || null };
      if (callerPhone) {
        console.log("[LiveKit Agent] Caller phone resolved:", callerPhone);
      } else {
        console.warn(
          "[LiveKit Agent] Caller phone not resolved from line/SIP; agent will ask the caller and use set_calling_phone.",
        );
      }

      const instructions = await getHospitalInstructions(
        hospital,
        sessionPhoneRef.value,
      );
      console.log(
        "[LiveKit Agent] Loaded hospital:",
        hospital.name || hospitalId,
      );

      const session = new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          model: OPENAI_REALTIME_MODEL,
          voice: "sage",
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

      session.once(voice.AgentSessionEventTypes.Close, () => {
        void runPostCallPipeline({
          session,
          hospital,
          callerPhone: sessionPhoneRef.value || callerPhone,
          roomName,
        }).catch((err) => {
          console.error(
            "[LiveKit Agent] Post-call pipeline error:",
            err && err.message ? err.message : err,
          );
        });
      });

      await session.start({
        agent: new HospitalVoiceAgent({
          instructions,
          hospitalObjectId: hospital._id,
          callerPhone,
          sessionPhoneRef,
        }),
        room: ctx.room,
        inputOptions: {
          noiseCancellation: BackgroundVoiceCancellation(),
        },
      });

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
