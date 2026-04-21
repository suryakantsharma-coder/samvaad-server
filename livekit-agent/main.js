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
const {
  extractSipCallerPhoneFromRoom,
} = require("./sipCallerPhone");

const AGENT_NAME = process.env.AGENT_NAME || "phone-agent";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini-2025-12-15";

const useSarvamStt = Boolean(
  process.env.SARVAM_API_KEY && process.env.SARVAM_API_KEY.trim(),
);

function parseHospitalIdFromRoom(roomName) {
  const prefix = "hospital-";
  if (!roomName || !String(roomName).startsWith(prefix)) return null;
  const id = String(roomName).slice(prefix.length).trim();
  if (!mongoose.isValidObjectId(id)) return null;
  return id;
}

function redactToken(token) {
  if (token == null || token === "") return null;
  const s = String(token);
  if (s.length <= 14) return "***";
  return `${s.slice(0, 10)}…(len=${s.length})`;
}

/** Safe snapshot of protobuf-like job for console (no raw join token). */
function snapshotJob(job) {
  if (!job) return null;
  try {
    const room = job.room;
    return {
      id: job.id,
      type: job.type,
      namespace: job.namespace,
      agentName: job.agentName,
      metadata: job.metadata,
      room: room
        ? {
            name: room.name,
            sid: room.sid,
            metadata: room.metadata,
            numParticipants: room.numParticipants,
          }
        : null,
    };
  } catch (e) {
    return { _snapshotError: e.message };
  }
}

function snapshotRemoteParticipants(room) {
  if (!room || !room.remoteParticipants) return [];
  const out = [];
  try {
    for (const p of room.remoteParticipants.values()) {
      const info = p.info;
      out.push({
        identity: p.identity,
        sid: p.sid,
        name: info && info.name,
        metadata: info && info.metadata,
        kind: info && info.kind,
      });
    }
  } catch (e) {
    return [{ _error: e.message }];
  }
  return out;
}

/**
 * Log everything useful when a call/job is handled (before or after RTC connect).
 * @param {import('@livekit/agents').JobContext} ctx
 * @param {string} phase - label for the log block
 * @param {object} [extra] - optional extra fields (e.g. hospital summary)
 */
async function logCallConnection(ctx, phase, extra = {}) {
  const payload = {
    phase,
    timestamp: new Date().toISOString(),
    workerId: ctx.workerId,
    job: snapshotJob(ctx.job),
    runningJob: ctx.info
      ? {
          url: ctx.info.url,
          token: redactToken(ctx.info.token),
          workerId: ctx.info.workerId,
        }
      : null,
    room: (() => {
      try {
        const r = ctx.room;
        if (!r) return null;
        return {
          name: r.name,
          metadata: r.metadata,
          connectionState: r.connectionState,
          isConnected: r.isConnected,
          numParticipants: r.numParticipants,
          numPublishers: r.numPublishers,
          remoteParticipantCount: r.remoteParticipants
            ? r.remoteParticipants.size
            : 0,
          localParticipant: r.localParticipant
            ? {
                identity: r.localParticipant.identity,
                sid: r.localParticipant.sid,
                metadata: r.localParticipant.metadata,
              }
            : undefined,
        };
      } catch (e) {
        return { _error: e.message };
      }
    })(),
    remoteParticipants: snapshotRemoteParticipants(ctx.room),
    agent: ctx.agent
      ? {
          identity: ctx.agent.identity,
          sid: ctx.agent.sid,
          metadata: ctx.agent.metadata,
        }
      : null,
    ...extra,
  };

  try {
    if (ctx.room && typeof ctx.room.getSid === "function") {
      payload.roomSid = await ctx.room.getSid();
    }
  } catch (e) {
    payload.roomSidError = e.message;
  }

  console.log(
    `[LiveKit Agent] Call / job context (${phase})`,
    JSON.stringify(payload, null, 2),
  );
}

/** When using Sarvam STT, discard mic audio committed to OpenAI so the model only sees Sarvam text. */
function patchRealtimeCommitToClearOnly(agent) {
  const activity = agent && agent._agentActivity;
  const rs = activity && activity.realtimeLLMSession;
  if (!rs || typeof rs.commitAudio !== "function" || typeof rs.clearAudio !== "function") {
    return;
  }
  const clear = rs.clearAudio.bind(rs);
  rs.commitAudio = async () => {
    await clear();
  };
}

/**
 * Prefer job metadata; otherwise read Exotel/SIP `sip_+91...` from remote participant identity / track names.
 */
async function resolveCallerPhone(ctx) {
  const fromJob =
    (ctx.job && ctx.job.metadata && ctx.job.metadata.callerPhone) ||
    (ctx.job && ctx.job.metadata && ctx.job.metadata.phone) ||
    null;
  if (fromJob && String(fromJob).trim()) {
    return {
      phone: String(fromJob).trim(),
      source: "job_metadata",
    };
  }

  let sip = extractSipCallerPhoneFromRoom(ctx.room);
  if (sip) {
    return { phone: sip, source: "sip_identity" };
  }

  try {
    await ctx.waitForParticipant();
  } catch (e) {
    console.warn(
      "[LiveKit Agent] waitForParticipant (optional):",
      e && e.message ? e.message : e,
    );
  }

  sip = extractSipCallerPhoneFromRoom(ctx.room);
  if (sip) {
    return { phone: sip, source: "sip_identity" };
  }

  return { phone: null, source: null };
}

const agentDef = defineAgent({
  entry: async (ctx) => {
    await logCallConnection(ctx, "job_received", {
      agentName: AGENT_NAME,
      openaiRealtimeModel: OPENAI_REALTIME_MODEL,
      useSarvamStt,
    });
    try {
      const roomName =
        ctx.job && ctx.job.room && ctx.job.room.name
          ? String(ctx.job.room.name)
          : ctx.room && ctx.room.name
            ? String(ctx.room.name)
            : "";

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

      const { phone: callerPhone, source: callerPhoneSource } =
        await resolveCallerPhone(ctx);

      const instructions = await getHospitalInstructions(hospital, callerPhone);

      await logCallConnection(ctx, "hospital_and_caller_resolved", {
        roomName: roomName || "(unknown)",
        hospitalId,
        hospitalName: hospital.name,
        callerPhone,
        callerPhoneSource,
        instructionsLength: instructions ? String(instructions).length : 0,
      });

      let vad;
      let sarvamStt;
      if (useSarvamStt) {
        const { VAD } = require("@livekit/agents-plugin-silero");
        const { SarvamSTT } = require("./sarvamStt");
        vad = await VAD.load({ sampleRate: 16000 });
        sarvamStt = new SarvamSTT();
      }

      const realtimeModelOpts = useSarvamStt
        ? {
            model: OPENAI_REALTIME_MODEL,
            voice: "sage",
            toolChoice: "auto",
            turnDetection: null,
            inputAudioTranscription: null,
          }
        : {
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
          };

      const session = new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel(realtimeModelOpts),
        ...(useSarvamStt && vad && sarvamStt ? { vad, stt: sarvamStt } : {}),
      });

      const hospitalAgent = new HospitalVoiceAgent({
        instructions,
        hospitalObjectId: hospital._id,
        callerPhone,
        routeUserTextThroughRealtime: useSarvamStt,
      });

      await session.start({
        agent: hospitalAgent,
        room: ctx.room,
        inputOptions: {
          noiseCancellation: BackgroundVoiceCancellation(),
        },
      });

      if (useSarvamStt) {
        patchRealtimeCommitToClearOnly(hospitalAgent);
      }

      await logCallConnection(ctx, "rtc_connected", {
        voicePipeline: useSarvamStt
          ? "sarvam_stt + silero_vad → text → openai_realtime"
          : "openai_realtime (server_vad + built-in transcription)",
        inputProcessing: useSarvamStt
          ? "Sarvam REST STT; Realtime commitAudio patched to clearAudio"
          : "default",
        noiseCancellation: "BackgroundVoiceCancellation",
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
if (useSarvamStt) {
  console.log(
    "[LiveKit Agent] Optional: SARVAM_STT_MODEL (default saaras:v3), SARVAM_LANGUAGE_CODE (default unknown), SARVAM_STT_MODE (default transcribe)",
  );
}
cli.runApp(
  new ServerOptions({
    agent: __filename,
    agentName: AGENT_NAME,
  }),
);
