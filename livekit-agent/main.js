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
const { chatItemsToTranscript } = require("./postCallPipeline");
const { enqueuePostCallJob } = require("../src/queues/postCallQueue");

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
      console.log(`[LiveKit Agent] Job received — room: ${roomName}`);

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
        void _epMin;
      } else {
        hospital = await HospitalModel.findById(hospitalId).lean();
        if (!hospital) {
          throw new Error(`[LiveKit Agent] Hospital not found: ${hospitalId}`);
        }
      }

      const { phone: callerPhone, source: callerPhoneSource } =
        await resolveCallerPhone(ctx);

      const instructions = await getHospitalInstructions(hospital, callerPhone);

      console.log(
        `[LiveKit Agent] Hospital resolved — ${hospital.name} (${hospitalId}) | caller: ${callerPhone || "unknown"} [${callerPhoneSource || "none"}]`,
      );

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

      const noInputRepromptMs = parseEnvMs("AGENT_NO_INPUT_REPROMPT_MS", 4000);
      if (noInputRepromptMs > 0) {
        attachNoInputReprompt(session, { ms: noInputRepromptMs });
      }

      // ── Post-call appointment pipeline ────────────────────────────────────
      // When the room disconnects, extract the in-memory transcript and enqueue
      // a BullMQ job.  The worker (running in the Express process) translates
      // the transcript to English, calls ChatGPT to extract appointment intent,
      // and creates the appointment in MongoDB — all outside the live call so
      // the voice agent never blocks waiting for DB writes.
      // The flag prevents double-firing if multiple disconnect events arrive.
      let _postCallEnqueued = false;
      const _schedulePostCall = () => {
        if (_postCallEnqueued) return;
        _postCallEnqueued = true;
        try {
          const originalLanguageTranscript = chatItemsToTranscript(session.chatCtx);
          if (originalLanguageTranscript.length === 0) {
            console.log("[LiveKit Agent] Post-call: empty transcript — skipping job.");
            return;
          }
          enqueuePostCallJob({
            originalLanguageTranscript,
            hospitalId: String(hospital._id),
            hospitalName: hospital.name || "",
            callerPhone: callerPhone || null,
            roomName,
          })
            .then((jobId) => {
              console.log(
                `[LiveKit Agent] Post-call job enqueued — id: ${jobId}, turns: ${originalLanguageTranscript.length}`,
              );
            })
            .catch((err) => {
              console.error(
                "[LiveKit Agent] Failed to enqueue post-call job:",
                err && err.message ? err.message : err,
              );
            });
        } catch (err) {
          console.error(
            "[LiveKit Agent] Post-call transcript extraction error:",
            err && err.message ? err.message : err,
          );
        }
      };

      // Listen on both the room and session so we catch whichever fires first.
      ctx.room.once("disconnected", _schedulePostCall);
      if (session && typeof session.once === "function") {
        session.once("close", _schedulePostCall);
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

      console.log(`[LiveKit Agent] RTC connected — room: ${roomName}`);

      const handle = session.generateReply({
        instructions: `Greeting in Hindi only: "नमस्ते, ${hospital.name} में आपका स्वागत है। मैं नेहा बोल रही हूँ, मैं आपकी कैसे मदद कर सकती हूँ?" Then in Hindi ask: "कृपया बताएं, क्या आप हिंदी में बात करेंगे या गुजराती में?" (Rest of the call then follows the instructions in the caller's language.)`,
      });
      await handle.waitForPlayout();
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
cli.runApp(
  new ServerOptions({
    agent: __filename,
    agentName: AGENT_NAME,
  }),
);
