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
const { attachNoInputReprompt } = require("./attachNoInputReprompt");
const { runPostCallPipeline } = require("./postCallPipeline");

const AGENT_NAME = process.env.AGENT_NAME || "phone-agent";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini-2025-12-15";
const OPENAI_LLM_MODEL =
  process.env.OPENAI_LLM_MODEL || "gpt-4.1";

const useSarvamStt = Boolean(
  process.env.SARVAM_API_KEY && process.env.SARVAM_API_KEY.trim(),
);

/** @param {string} name @param {number} def */
function parseEnvMs(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Slides ~300ms off default stack (Silero 550ms silence + LiveKit 500ms endpointing). Tweak with env. */
const SARVAM_VAD_LOAD_OPTS = {
  sampleRate: 16000,
  minSilenceDuration: parseEnvMs("VAD_MIN_SILENCE_MS", 360),
  prefixPaddingDuration: parseEnvMs("VAD_PREFIX_PADDING_MS", 280),
};

function getSarvamTurnHandling() {
  return {
    turnDetection: "vad",
    endpointing: {
      minDelay: parseEnvMs("AGENT_ENDPOINTING_MIN_MS", 220),
    },
  };
}

function buildOpenAiChatLlm() {
  const opts = { model: OPENAI_LLM_MODEL };
  const t = process.env.OPENAI_LLM_TEMPERATURE;
  if (t != null && t !== "" && !Number.isNaN(Number(t))) {
    opts.temperature = Number(t);
  } else {
    opts.temperature = 0.45;
  }
  return new openai.LLM(opts);
}

/**
 * Resolves the hospital Mongo id from a LiveKit room name.
 * Supports plain `hospital-{objectId}` and common trunk/SIP forms like
 * `hospital-{objectId}-call-...` (only the 24-hex id segment is used).
 */
function parseHospitalIdFromRoom(roomName) {
  const s = String(roomName || "").trim();
  if (!s.startsWith("hospital-")) return null;
  const after = s.slice("hospital-".length);
  const m = after.match(/^([0-9a-fA-F]{24})(?:$|-)/);
  if (!m) return null;
  const id = m[1];
  return mongoose.isValidObjectId(id) ? id : null;
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
  prewarm: async (_proc) => {
    if (!useSarvamStt) return;
    try {
      const { VAD } = require("@livekit/agents-plugin-silero");
      await VAD.load(SARVAM_VAD_LOAD_OPTS);
      console.log(
        "[LiveKit Agent] Prewarm: Silero VAD ready",
        `minSilence=${SARVAM_VAD_LOAD_OPTS.minSilenceDuration}ms`,
      );
    } catch (e) {
      console.warn(
        "[LiveKit Agent] Prewarm: VAD load failed, will load in entry:",
        e && e.message ? e.message : e,
      );
    }
  },
  entry: async (ctx) => {
    const roomName =
      ctx.job && ctx.job.room && ctx.job.room.name
        ? String(ctx.job.room.name)
        : ctx.room && ctx.room.name
          ? String(ctx.room.name)
          : "";

    const hospitalId = parseHospitalIdFromRoom(roomName);
    if (!hospitalId) {
      throw new Error(
        `[LiveKit Agent] Invalid room name "${roomName}". Expected hospital-{mongoObjectId} (optional suffix after a second hyphen, e.g. -call-…).`,
      );
    }

    // Connect first. Anything awaited before connect (e.g. logging + getSid) delays the
    // agent participant, so the caller can be in the room with no agent visible.
    await ctx.connect();

    try {
      await logCallConnection(ctx, "job_received", {
        agentName: AGENT_NAME,
        openaiRealtimeModel: OPENAI_REALTIME_MODEL,
        useSarvamStt,
      });

      await ensureMongoConnected();

      const {
        useSamvaadVoiceLlmPipeline,
        SarvamTTS: SarvamTTSClass,
      } = require("./sarvamTts");
      const useSamvaadLlmTts = useSarvamStt && useSamvaadVoiceLlmPipeline();

      let hospital;
      let vad;
      let sarvamStt;
      if (useSarvamStt) {
        const { VAD } = require("@livekit/agents-plugin-silero");
        const { SarvamSTT, useWebSocketStreaming } = require("./sarvamStt");
        [hospital, vad] = await Promise.all([
          HospitalModel.findById(hospitalId).lean(),
          VAD.load(SARVAM_VAD_LOAD_OPTS),
        ]);
        if (!hospital) {
          throw new Error(`[LiveKit Agent] Hospital not found: ${hospitalId}`);
        }
        sarvamStt = new SarvamSTT();
        sarvamStt.on("error", (ev) => {
          console.error(
            "[Sarvam STT] stt error event:",
            ev && ev.error != null ? ev.error : ev,
          );
        });
        sarvamStt.on("metrics_collected", (m) => {
          if (process.env.SARVAM_STT_DEBUG === "0") return;
          console.log(
            "[Sarvam STT] metrics:",
            m && m.metadata ? m.metadata : m,
            m && m.audioDurationMs != null ? `audioMs=${m.audioDurationMs}` : "",
          );
        });
        const _epMin = getSarvamTurnHandling().endpointing.minDelay;
        console.log(
          "[LiveKit Agent] Sarvam STT:",
          useWebSocketStreaming() ? "WebSocket streaming" : "batch REST + Silero VAD",
          `| VAD minSilence=${SARVAM_VAD_LOAD_OPTS.minSilenceDuration}ms prefixPad=${SARVAM_VAD_LOAD_OPTS.prefixPaddingDuration}ms endpointingMin=${_epMin}ms`,
          "| env: VAD_MIN_SILENCE_MS, VAD_PREFIX_PADDING_MS, AGENT_ENDPOINTING_MIN_MS | try SARVAM_STT_STREAMING=1, OPENAI_LLM_MODEL=gpt-4o-mini",
          "| SARVAM_STT_DEBUG=1 for transcripts; SARVAM_STT_DEBUG=0 off",
        );
      } else {
        hospital = await HospitalModel.findById(hospitalId).lean();
        if (!hospital) {
          throw new Error(`[LiveKit Agent] Hospital not found: ${hospitalId}`);
        }
      }

      const { phone: callerPhone, source: callerPhoneSource } =
        await resolveCallerPhone(ctx);

      const instructions = await getHospitalInstructions(hospital, callerPhone, {
        deferBookingToPostCall: true,
      });

      await logCallConnection(ctx, "hospital_and_caller_resolved", {
        roomName: roomName || "(unknown)",
        hospitalId,
        hospitalName: hospital.name,
        callerPhone,
        callerPhoneSource,
        instructionsLength: instructions ? String(instructions).length : 0,
      });

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

      const samvaadTts =
        useSamvaadLlmTts && useSarvamStt ? new SarvamTTSClass() : null;
      if (samvaadTts) {
        samvaadTts.on("error", (ev) => {
          console.error(
            "[Sarvam TTS] error event:",
            ev && ev.error != null ? ev.error : ev,
          );
        });
        console.log(
          "[LiveKit Agent] Voice pipeline: Sarvam STT →",
          OPENAI_LLM_MODEL,
          "→ Sarvam TTS (WebSocket, linear16) | aecWarmup=0, optional NC off",
        );
      }

      const lowLatency = process.env.LOW_LATENCY_AUDIO !== "0";
      const sarvamTurnHandling = useSarvamStt ? getSarvamTurnHandling() : void 0;
      const session = useSamvaadLlmTts
        ? new voice.AgentSession({
            vad,
            stt: sarvamStt,
            llm: buildOpenAiChatLlm(),
            tts: samvaadTts,
            aecWarmupDuration: 0,
            turnHandling: sarvamTurnHandling,
            connOptions: {
              llmConnOptions: { maxRetry: 2 },
              ttsConnOptions: { maxRetry: 1 },
            },
          })
        : new voice.AgentSession({
            llm: new openai.realtime.RealtimeModel(realtimeModelOpts),
            ...(useSarvamStt && vad && sarvamStt
              ? { vad, stt: sarvamStt, aecWarmupDuration: 0, turnHandling: sarvamTurnHandling }
              : {}),
          });

      const hospitalAgent = new HospitalVoiceAgent({
        instructions,
        hospitalObjectId: hospital._id,
        callerPhone,
        routeUserTextThroughRealtime: useSarvamStt && !useSamvaadLlmTts,
        includeBookingTools: false,
      });

      const inputOpts =
        useSamvaadLlmTts && lowLatency
          ? {
              textEnabled: true,
              audioEnabled: true,
              noiseCancellation: void 0,
            }
          : { noiseCancellation: BackgroundVoiceCancellation() };

      await session.start({
        agent: hospitalAgent,
        room: ctx.room,
        inputOptions: inputOpts,
      });

      ctx.addShutdownCallback(async () => {
        try {
          await ensureMongoConnected();
          await runPostCallPipeline({
            session,
            hospital,
            callerPhone,
            roomName,
          });
        } catch (err) {
          console.error(
            "[LiveKit Agent] Post-call pipeline error:",
            err && err.message ? err.message : err,
          );
        }
      });

      const noInputRepromptMs = parseEnvMs("AGENT_NO_INPUT_REPROMPT_MS", 4000);
      if (noInputRepromptMs > 0) {
        attachNoInputReprompt(session, { ms: noInputRepromptMs });
      }

      const { PcmGainAudioOutput, getAgentOutputPcmGain } = require("./pcmGainAudioOutput");
      const outPcmGain = getAgentOutputPcmGain(Boolean(useSamvaadLlmTts));
      if (session.output.audio && outPcmGain !== 1) {
        session.output.audio = new PcmGainAudioOutput(
          session.output.audio,
          outPcmGain,
        );
        console.log(
          "[LiveKit Agent] output PCM gain (all published agent audio):",
          outPcmGain,
          "| env: LIVEKIT_AGENT_OUTPUT_PCM_GAIN (all pipelines), OPENAI_REALTIME_OUTPUT_PCM_GAIN (Realtime only, default 1.85 if unset), Samvaad default 1 (use SARVAM_TTS_GAIN)",
        );
      }

      if (useSarvamStt && !useSamvaadLlmTts) {
        patchRealtimeCommitToClearOnly(hospitalAgent);
      }

      await logCallConnection(ctx, "rtc_connected", {
        voicePipeline: (() => {
          if (!useSarvamStt) {
            return "openai_realtime (server_vad + built-in transcription)";
          }
          if (useSamvaadLlmTts) {
            return "sarvam_stt → openai_LLM+tools → sarvam_tts_ws (linear16)";
          }
          return require("./sarvamStt").useWebSocketStreaming()
            ? "sarvam_ws_stream + silero_vad → text → openai_realtime"
            : "sarvam_rest + silero_vad (StreamAdapter) → text → openai_realtime";
        })(),
        inputProcessing: (() => {
          if (!useSarvamStt) return "default";
          if (useSamvaadLlmTts) {
            return "no Realtime; aecWarmup=0; LOW_LATENCY_AUDIO=0 restores NC";
          }
          return require("./sarvamStt").useWebSocketStreaming()
            ? "Sarvam WebSocket (PCM) STT; Realtime commitAudio → clearAudio"
            : "Sarvam batch REST per utterance; Realtime commitAudio → clearAudio";
        })(),
        noiseCancellation: useSamvaadLlmTts
          ? lowLatency
            ? "off (LOW_LATENCY default)"
            : "BackgroundVoiceCancellation"
          : "BackgroundVoiceCancellation",
      });

      const handle = session.generateReply({
        instructions: `Greeting in Hindi only: "नमस्ते, ${hospital.name} में आपका स्वागत है। मैं नेहा बोल रही हूँ, मैं आपकी कैसे मदद कर सकती हूँ?" Then in Hindi ask: "कृपया बताएं, क्या आप हिंदी में बात करेंगे या गुजराती में?" (Rest of the call then follows the instructions in the caller's language.)`,
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
console.log(
  "[LiveKit Agent] No-input reprompt: AGENT_NO_INPUT_REPROMPT_MS=" +
    parseEnvMs("AGENT_NO_INPUT_REPROMPT_MS", 4000) +
    " (0=off). After silence, agent says sorry (Hindi or Gujarati) and repeats the last question.",
);
if (useSarvamStt) {
  console.log(
    "[LiveKit Agent] Latency tuners (defaults already tuned down): VAD_MIN_SILENCE_MS=" +
      SARVAM_VAD_LOAD_OPTS.minSilenceDuration +
      ", VAD_PREFIX_PADDING_MS=" +
      SARVAM_VAD_LOAD_OPTS.prefixPaddingDuration +
      ", AGENT_ENDPOINTING_MIN_MS=" +
      parseEnvMs("AGENT_ENDPOINTING_MIN_MS", 220) +
      " | TTS first-chunk: SARVAM_TTS_MIN_BUFFER (default 12 chars) | LLM: OPENAI_LLM_TEMPERATURE (default 0.45 for Samvaad path)",
  );
  console.log(
    "[LiveKit Agent] Sarvam env: SARVAM_STT_STREAMING=1 for WebSocket (default is batch REST). SARVAM_STT_DEBUG=0 silences [Sarvam STT] logs.",
  );
  console.log(
    "[LiveKit Agent] Optional: SARVAM_STT_MODEL (default saaras:v3), SARVAM_LANGUAGE_CODE (default unknown), SARVAM_STT_MODE (default transcribe, REST only)",
  );
  console.log(
    "[LiveKit Agent] USE_SAMVAAD_VOICE_LLM=1 → Sarvam STT + OpenAI chat (" +
      (process.env.OPENAI_LLM_MODEL || "gpt-4.1") +
      ") + Sarvam TTS (WebSocket). LOW_LATENCY_AUDIO=0 keeps noise cancellation (default: fast path without NC).",
  );
  console.log(
    "[LiveKit Agent] TTS: bulbul — SARVAM_TTS_LOUDNESS (API 0.3–3, default 3), SARVAM_TTS_GAIN (PCM after decode, default 3, max 4; 1=off), bulbul:v3 may ignore API loudness; SARVAM_TTS_MODEL, SARVAM_TTS_SPEAKER, SARVAM_TTS_LANGUAGE, SARVAM_TTS_DEBUG=0",
  );
}
if (useSarvamStt && !process.env.USE_SAMVAAD_VOICE_LLM) {
  console.log(
    "[LiveKit Agent] Realtime output loudness: default OPENAI_REALTIME_OUTPUT_PCM_GAIN=1.85 (empty env). Override: OPENAI_REALTIME_OUTPUT_PCM_GAIN=2.5, or LIVEKIT_AGENT_OUTPUT_PCM_GAIN=2 (all voice pipelines). See startup log after each job for applied gain.",
  );
}
cli.runApp(
  new ServerOptions({
    agent: __filename,
    agentName: AGENT_NAME,
  }),
);
