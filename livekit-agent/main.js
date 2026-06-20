const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
if (!process.env.TZ) {
  process.env.TZ = "Asia/Kolkata";
}

const mongoose = require("mongoose");
const { ServerOptions, cli, defineAgent, voice } = require("@livekit/agents");
const openai = require("@livekit/agents-plugin-openai");
const {
  BackgroundVoiceCancellation,
  NoiseCancellation,
  TelephonyBackgroundVoiceCancellation,
} = require("@livekit/noise-cancellation-node");
const { HospitalVoiceAgent } = require("./agent");
const { ensureMongoConnected } = require("./dbConnect");
const HospitalModel = require("../src/models/hospital.model");
const { getHospitalInstructions } = require("../src/agent/hospitalPrompt");
const { extractSipCallerPhoneFromRoom } = require("./sipCallerPhone");
const { attachNoInputReprompt } = require("./attachNoInputReprompt");
const { getNoInputMissingTopic } = require("./bookingTurnInstructions");
const { attachCallLogger } = require("./callLogger");

const AGENT_NAME = process.env.AGENT_NAME || "phone-agent";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini-2025-12-15";
const OPENAI_LLM_MODEL = process.env.OPENAI_LLM_MODEL || "gpt-4.1";

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

/** Caller-side mic noise suppression before STT (LiveKit AudioFilter). */
function envInputNoiseCancellationMode() {
  return String(process.env.LIVEKIT_INPUT_NOISE_CANCELLATION || "telephony")
    .trim()
    .toLowerCase();
}

/**
 * @returns {ReturnType<typeof TelephonyBackgroundVoiceCancellation> | undefined}
 */
function getInputNoiseCancellationOptions() {
  const mode = envInputNoiseCancellationMode();
  if (mode === "off" || mode === "0" || mode === "false" || mode === "none") {
    return undefined;
  }
  if (mode === "bvc" || mode === "background" || mode === "voice") {
    return BackgroundVoiceCancellation();
  }
  if (mode === "nc" || mode === "standard" || mode === "noise") {
    return NoiseCancellation();
  }
  /** telephony | sip | phone — model tuned for narrowband / phone audio */
  if (
    mode === "telephony" ||
    mode === "sip" ||
    mode === "phone" ||
    mode === "bvct"
  ) {
    return TelephonyBackgroundVoiceCancellation();
  }
  return TelephonyBackgroundVoiceCancellation();
}

function inputNcForceWithLowLatency() {
  const v = String(process.env.LIVEKIT_INPUT_NC_WITH_LOW_LATENCY || "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

function shouldSkipInputNcForLatency(useSamvaadLlmTts, lowLatency) {
  return Boolean(
    useSamvaadLlmTts && lowLatency && !inputNcForceWithLowLatency(),
  );
}

/**
 * For logs / observability (one line per job).
 * @param {{ useSamvaadLlmTts: boolean, lowLatency: boolean }} p
 */
function getInputNoiseCancellationStatus(p) {
  const mode = envInputNoiseCancellationMode();
  if (mode === "off" || mode === "0" || mode === "false" || mode === "none") {
    return {
      active: false,
      summary: "off (LIVEKIT_INPUT_NOISE_CANCELLATION)",
    };
  }
  const skip = shouldSkipInputNcForLatency(p.useSamvaadLlmTts, p.lowLatency);
  if (skip) {
    return {
      active: false,
      summary:
        "skipped: Samvaad low-latency path (set LOW_LATENCY_AUDIO=0 or LIVEKIT_INPUT_NC_WITH_LOW_LATENCY=1)",
    };
  }
  const kind =
    mode === "bvc" || mode === "background" || mode === "voice"
      ? "BackgroundVoiceCancellation"
      : mode === "nc" || mode === "standard" || mode === "noise"
        ? "NoiseCancellation"
        : "TelephonyBackgroundVoiceCancellation";
  return { active: true, summary: `${kind} mode=${mode}` };
}

/**
 * @param {{ useSamvaadLlmTts: boolean, lowLatency: boolean }} p
 */
function buildAgentSessionInputOptions(p) {
  const { useSamvaadLlmTts, lowLatency } = p;
  const ncOpts = getInputNoiseCancellationOptions();
  const skipNcForSpeed = shouldSkipInputNcForLatency(
    useSamvaadLlmTts,
    lowLatency,
  );
  const effectiveNc = skipNcForSpeed ? undefined : ncOpts;

  if (useSamvaadLlmTts && lowLatency) {
    return {
      textEnabled: true,
      audioEnabled: true,
      noiseCancellation: effectiveNc,
    };
  }
  return { noiseCancellation: effectiveNc };
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
  if (
    !rs ||
    typeof rs.commitAudio !== "function" ||
    typeof rs.clearAudio !== "function"
  ) {
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

    let session = null;
      let detachEmergencyEnd = null;
      let detachNoInput = null;
    let samvaadTts = null;
    let hospitalAgent = null;
    let sarvamStt = null;
    let callLogger = null;

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
            JSON.stringify({
              roomName,
              hospitalId,
              error: ev && ev.error != null ? ev.error : ev,
            }),
          );
        });
        sarvamStt.on("metrics_collected", (m) => {
          if (process.env.SARVAM_STT_DEBUG === "0") return;
          console.log(
            "[Sarvam STT] metrics:",
            m && m.metadata ? m.metadata : m,
            m && m.audioDurationMs != null
              ? `audioMs=${m.audioDurationMs}`
              : "",
          );
        });
        const _epMin = getSarvamTurnHandling().endpointing.minDelay;
        console.log(
          "[LiveKit Agent] Sarvam STT:",
          useWebSocketStreaming()
            ? "WebSocket streaming"
            : "batch REST + Silero VAD",
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

      const instructions = await getHospitalInstructions(hospital, callerPhone);

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
            turnDetection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
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

      const samvaadTtsInstance =
        useSamvaadLlmTts && useSarvamStt ? new SarvamTTSClass() : null;
      samvaadTts = samvaadTtsInstance;
      if (samvaadTts) {
        samvaadTts.on("error", (ev) => {
          console.error(
            "[Sarvam TTS] error event:",
            JSON.stringify({
              roomName,
              hospitalId,
              error: ev && ev.error != null ? ev.error : ev,
            }),
          );
        });
        console.log(
          "[LiveKit Agent] Voice pipeline: Sarvam STT →",
          OPENAI_LLM_MODEL,
          "→ Sarvam TTS (WebSocket, linear16) | aecWarmup=0 | caller NC: LIVEKIT_INPUT_NOISE_CANCELLATION (default telephony), LIVEKIT_INPUT_NC_WITH_LOW_LATENCY=1 to keep NC on low-latency path",
        );
      }

      const lowLatency = process.env.LOW_LATENCY_AUDIO !== "0";
      const sarvamTurnHandling = useSarvamStt
        ? getSarvamTurnHandling()
        : void 0;
      session = useSamvaadLlmTts
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
              ? {
                  vad,
                  stt: sarvamStt,
                  aecWarmupDuration: 0,
                  turnHandling: sarvamTurnHandling,
                }
              : {}),
          });

      hospitalAgent = new HospitalVoiceAgent({
        instructions,
        hospitalObjectId: hospital._id,
        callerPhone,
        routeUserTextThroughRealtime: useSarvamStt && !useSamvaadLlmTts,
        getCallLogger: () => callLogger,
      });
      hospitalAgent._hospital = { name: hospital.name };
      hospitalAgent._callRoomName = roomName;

      const inputOpts = buildAgentSessionInputOptions({
        useSamvaadLlmTts: Boolean(useSamvaadLlmTts),
        lowLatency,
      });
      console.log(
        "[LiveKit Agent] Caller-side input noise cancellation:",
        getInputNoiseCancellationStatus({
          useSamvaadLlmTts: Boolean(useSamvaadLlmTts),
          lowLatency,
        }).summary,
      );

      await session.start({
        agent: hospitalAgent,
        room: ctx.room,
        inputOptions: inputOpts,
      });

      callLogger = attachCallLogger({
        session,
        hospital,
        callerPhone,
        roomName,
        voicePipeline: (() => {
          if (!useSarvamStt) return "openai_realtime";
          if (useSamvaadLlmTts) return "sarvam_stt → openai_chat → sarvam_tts";
          return require("./sarvamStt").useWebSocketStreaming()
            ? "sarvam_ws_stt → openai_realtime"
            : "sarvam_rest_stt → openai_realtime";
        })(),
      });

      const { attachEmergencyCallEndBridge } = require("./emergencyCallEnd");
      detachEmergencyEnd = attachEmergencyCallEndBridge(session, hospitalAgent);

      const noInputRepromptMs = parseEnvMs("AGENT_NO_INPUT_REPROMPT_MS", 4000);
      if (noInputRepromptMs > 0) {
        detachNoInput = attachNoInputReprompt(session, {
          ms: noInputRepromptMs,
          getPreferredLanguage: () =>
            hospitalAgent ? hospitalAgent.preferredLanguage : "hi",
          getNoInputTopic: () =>
            hospitalAgent
              ? getNoInputMissingTopic(
                  hospitalAgent.callBookingSlots,
                  hospitalAgent.preferredLanguage,
                )
              : null,
          shouldSuppressReprompt: () =>
            hospitalAgent
              ? hospitalAgent.shouldSuppressNoInputReprompt()
              : false,
          onReprompt: (info) => {
            if (callLogger) {
              callLogger.log("reprompt", {
                reason: "no_input",
                lang: info && info.lang ? info.lang : null,
                missingTopic:
                  info && info.missingTopic ? info.missingTopic : null,
              });
            }
          },
        });
      }

      if (useSamvaadLlmTts && samvaadTts) {
        session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
          if (!ev || !ev.isFinal) return;
          hospitalAgent.updateLanguageFromTranscript(ev.transcript || "");
          samvaadTts._targetLanguageCode =
            hospitalAgent.preferredLanguage === "en"
              ? "en-IN"
              : hospitalAgent.preferredLanguage === "gu"
                ? "gu-IN"
                : "hi-IN";
        });
      } else if (useSarvamStt) {
        /**
         * In the Sarvam-STT → OpenAI Realtime pipeline, `onUserTurnCompleted`
         * does NOT fire because user text is injected directly into the
         * Realtime model, not through LiveKit's chat-context path. Without
         * this hook, `hospitalAgent.preferredLanguage` stays at "hi" forever,
         * which causes no-input reprompts and post-booking status lines to
         * speak Hindi in the middle of an English call. Mirror the language
         * inference + STT-side slot capture here so the side-channels work.
         */
        session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
          if (!ev || !ev.isFinal) return;
          const text = String(ev.transcript || "");
          if (!text.trim()) return;
          try {
            hospitalAgent.updateLanguageFromTranscript(text);
          } catch (e) {
            console.warn(
              "[LiveKit Agent] STT language sync failed:",
              e && e.message ? e.message : e,
            );
          }
          try {
            hospitalAgent.applyCallerTranscriptSideEffects(text);
          } catch (e) {
            console.warn(
              "[LiveKit Agent] STT slot capture failed:",
              e && e.message ? e.message : e,
            );
          }
        });
      }

      session.once(voice.AgentSessionEventTypes.Close, () => {
        if (detachEmergencyEnd) {
          detachEmergencyEnd();
          detachEmergencyEnd = null;
        }
        if (detachNoInput) {
          detachNoInput();
          detachNoInput = null;
        }
      });

      const {
        PcmGainAudioOutput,
        getAgentOutputPcmGain,
      } = require("./pcmGainAudioOutput");
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
            return "no Realtime; aecWarmup=0; NC: LOW_LATENCY_AUDIO=0, LIVEKIT_INPUT_NC_WITH_LOW_LATENCY=1, or LIVEKIT_INPUT_NOISE_CANCELLATION";
          }
          return require("./sarvamStt").useWebSocketStreaming()
            ? "Sarvam WebSocket (PCM) STT; Realtime commitAudio → clearAudio"
            : "Sarvam batch REST per utterance; Realtime commitAudio → clearAudio";
        })(),
        noiseCancellation: getInputNoiseCancellationStatus({
          useSamvaadLlmTts: Boolean(useSamvaadLlmTts),
          lowLatency,
        }).summary,
      });

      if (callLogger) {
        callLogger.log("generate_reply", {
          purpose: "initial_greeting",
          lang: "hi",
        });
      }
      let handle;
      try {
        handle = session.generateReply({
          instructions: `You are Neha (female receptionist). First speak in Hindi: welcome to ${hospital.name}, introduce yourself as Neha, and ask whether they want to continue in Hindi or in Gujrati ("बातचीत हिंदी में रखें या ગુજરાતીમાં में?"). After they clearly choose, use only that language for the rest of the call until they ask to switch.`,
        });
        await handle.waitForPlayout();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error("[LiveKit Agent] Greeting generateReply failed:", msg);
        if (callLogger) {
          callLogger.log("generate_reply_error", {
            purpose: "initial_greeting",
            errorMessage: msg,
          });
        }
      }

      if (callLogger)
        callLogger.log("greeting", { roomName, hospitalName: hospital.name });

      console.log(
        "[LiveKit Agent] Initial greeting sent for room:",
        roomName,
        "hospital:",
        hospital.name,
      );

      await new Promise((resolve) => {
        if (!session || session.closing) {
          resolve();
          return;
        }
        session.once(voice.AgentSessionEventTypes.Close, resolve);
      });
    } catch (err) {
      console.error(
        "[LiveKit Agent] Entry error:",
        err && err.message ? err.message : err,
      );
      throw err;
    } finally {
      if (detachEmergencyEnd) {
        detachEmergencyEnd();
        detachEmergencyEnd = null;
      }
      if (detachNoInput) {
        detachNoInput();
        detachNoInput = null;
      }
      if (callLogger) {
        try {
          callLogger.detach();
        } catch (logDetachErr) {
          console.warn(
            "[LiveKit Agent] callLogger.detach:",
            logDetachErr && logDetachErr.message
              ? logDetachErr.message
              : logDetachErr,
          );
        }
        callLogger = null;
      }
      if (session && typeof session.close === "function" && !session.closing) {
        try {
          await session.close();
        } catch (closeErr) {
          console.warn(
            "[LiveKit Agent] session.close:",
            closeErr && closeErr.message ? closeErr.message : closeErr,
          );
        }
      }
      if (sarvamStt && typeof sarvamStt.close === "function") {
        try {
          await sarvamStt.close();
        } catch (sttCloseErr) {
          console.warn(
            "[LiveKit Agent] sarvamStt.close:",
            sttCloseErr && sttCloseErr.message
              ? sttCloseErr.message
              : sttCloseErr,
          );
        }
      }
      if (samvaadTts && typeof samvaadTts.close === "function") {
        try {
          await samvaadTts.close();
        } catch (ttsCloseErr) {
          console.warn(
            "[LiveKit Agent] sarvamTts.close:",
            ttsCloseErr && ttsCloseErr.message
              ? ttsCloseErr.message
              : ttsCloseErr,
          );
        }
      }
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
      ") + Sarvam TTS (WebSocket). Caller NC: default telephony (LIVEKIT_INPUT_NOISE_CANCELLATION); LOW_LATENCY_AUDIO=0 or LIVEKIT_INPUT_NC_WITH_LOW_LATENCY=1 applies NC on this path.",
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
