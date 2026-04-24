const agents = require("@livekit/agents");
const { TTS, SynthesizeStream, ChunkedStream } = agents.tts;
const { shortuuid, AudioByteStream, APIError } = agents;
const { SarvamAIClient } = require("sarvamai");

function ttsLog(...args) {
  if (process.env.SARVAM_TTS_DEBUG === "0") return;
  console.log("[Sarvam TTS]", ...args);
}

function normalizeTtsMessage(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    type: raw.type ?? raw.Type,
    data: raw.data ?? raw.Data,
  };
}

/**
 * Sarvam `configureConnection.loudness` — API range 0.3–3.0 (may be ignored for bulbul:v3; still sent as max).
 * @param {string | undefined} [raw]
 */
function getSarvamApiLoudness(raw) {
  if (raw == null || raw === "") return 3.0;
  const g = Number(raw);
  if (!Number.isFinite(g)) return 3.0;
  return Math.min(3, Math.max(0.3, g));
}

/**
 * software PCM gain after decode — effective for all models, applied to linear16. Can exceed API loudness cap.
 * @param {number} [rawEnv] SARVAM_TTS_GAIN: 1 = off, default 3.0; max 4.0 (higher may clip)
 */
function getTtsOutputGain(rawEnv) {
  if (rawEnv == null || rawEnv === "") return 3.0;
  const g = Number(rawEnv);
  if (!Number.isFinite(g) || g <= 0) return 3.0;
  if (g === 1) return 1;
  return Math.min(4, Math.max(0.3, g));
}

/** Linear16 / s16le little-endian. Clips to int16. */
function applyPcmS16leGain(pcmBuffer, gain) {
  if (!gain || gain === 1) return pcmBuffer;
  const n = Math.floor(pcmBuffer.length / 2);
  const out = Buffer.allocUnsafe(pcmBuffer.length);
  for (let i = 0; i < n; i++) {
    const o = i * 2;
    const s = pcmBuffer.readInt16LE(o);
    const v = Math.round(s * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), o);
  }
  return out;
}

class SarvamTTS extends TTS {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model] e.g. bulbul:v2, bulbul:v3
   * @param {string} [opts.speaker] Sarvam speaker id, default pooja
   * @param {string} [opts.targetLanguageCode] e.g. hi-IN, gu-IN
   * @param {number} [opts.speechSampleRate] default 22050 (Sarvam streaming default)
   * @param {number} [opts.outputGain] PCM boost (v3 ignores API loudness); default from SARVAM_TTS_GAIN
   */
  constructor(opts = {}) {
    const sr =
      opts.speechSampleRate ||
      Number(process.env.SARVAM_TTS_SAMPLE_RATE) ||
      22050;
    super(sr, 1, { streaming: true, alignedTranscript: false });
    this.label = "sarvam.TTS";
    this._apiKey = opts.apiKey || process.env.SARVAM_API_KEY;
    this._model = opts.model || process.env.SARVAM_TTS_MODEL || "bulbul:v3";
    this._speaker = opts.speaker || process.env.SARVAM_TTS_SPEAKER || "pooja";
    this._targetLanguageCode =
      opts.targetLanguageCode || process.env.SARVAM_TTS_LANGUAGE || "hi-IN";
    this._speechSampleRate = sr;
    this._outputGain =
      opts.outputGain != null
        ? getTtsOutputGain(String(opts.outputGain))
        : getTtsOutputGain(process.env.SARVAM_TTS_GAIN);
    this._apiLoudness = getSarvamApiLoudness(process.env.SARVAM_TTS_LOUDNESS);
  }

  get model() {
    return this._model;
  }

  get provider() {
    return "sarvam";
  }

  get speechSampleRate() {
    return this._speechSampleRate;
  }

  /**
   * One-shot: full string over one WebSocket (for StreamAdapter / short replies).
   */
  synthesize(text, connOptions, abortSignal) {
    return new SarvamTTSChunked(this, String(text), connOptions, abortSignal);
  }

  /**
   * Streaming: LLM tokens → Sarvam convert + flush; audio chunks over WebSocket.
   */
  stream(options) {
    return new SarvamSynthesizeStream(
      this,
      options == null ? void 0 : options.connOptions,
    );
  }

  async close() {
    return;
  }
}

class SarvamSynthesizeStream extends SynthesizeStream {
  /**
   * @param {SarvamTTS} tts
   * @param {import('@livekit/agents').APIConnectOptions} [connOptions]
   */
  constructor(tts, connOptions) {
    super(tts, connOptions);
    this._sarvamTts = tts;
  }

  get label() {
    return "sarvam.SynthesizeStream";
  }

  async run() {
    const tts = this._sarvamTts;
    if (!tts._apiKey) {
      throw new APIError("Sarvam TTS: set SARVAM_API_KEY", {
        retryable: false,
      });
    }
    const client = new SarvamAIClient({ apiSubscriptionKey: tts._apiKey });
    const ttsSocket = await client.textToSpeechStreaming.connect({
      model: tts._model,
      send_completion_event: "true",
      "Api-Subscription-Key": tts._apiKey,
    });
    ttsSocket.connect();
    await ttsSocket.waitForOpen();

    ttsLog(
      "stream: WebSocket open, model=",
      tts._model,
      "lang=",
      tts._targetLanguageCode,
      "pcmGain=",
      tts._outputGain,
      "apiLoudness=",
      tts._apiLoudness,
    );
    ttsSocket.configureConnection({
      target_language_code: tts._targetLanguageCode,
      speaker: tts._speaker,
      output_audio_codec: "linear16",
      speech_sample_rate: tts._speechSampleRate,
      /** bulbul:v2; v3 may ignore but sending max 3.0 is harmless */
      loudness: tts._apiLoudness,
      enable_preprocessing: false,
      min_buffer_size: Math.max(
        1,
        Math.min(50, Number(process.env.SARVAM_TTS_MIN_BUFFER) || 12),
      ),
      max_chunk_length: Math.max(
        30,
        Math.min(500, Number(process.env.SARVAM_TTS_MAX_CHUNK) || 200),
      ),
    });

    const bstream = new AudioByteStream(tts._speechSampleRate, 1);
    const requestId = shortuuid("tts_");
    let segmentId = shortuuid("seg_");
    const finalResolvers = [];
    const waitNextFinal = () =>
      new Promise((resolve) => {
        finalResolvers.push(resolve);
      });
    const onFinal = () => {
      const r = finalResolvers.shift();
      if (r) r();
    };
    const withFinalTimeout = (p, ms) =>
      Promise.race([
        p,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new APIError("Sarvam TTS stream final wait timeout", {
                  retryable: true,
                }),
              ),
            ms,
          ),
        ),
      ]);

    const pushFrame = (frame, final) => {
      this.queue.put({
        requestId,
        segmentId,
        frame,
        final,
        deltaText: void 0,
      });
    };

    ttsSocket.on("message", (raw) => {
      if (this.abortController.signal.aborted) return;
      const msg = normalizeTtsMessage(raw);
      const type = msg.type;
      const data = msg.data;

      if (type === "error" && data) {
        const m = (data && data.message) || "Sarvam TTS error";
        this.emitError({
          error: new APIError(m, { retryable: true }),
          recoverable: true,
        });
        onFinal();
        return;
      }

      if (type === "audio" && data && data.audio) {
        let buf;
        try {
          buf = Buffer.from(data.audio, "base64");
        } catch (e) {
          ttsLog("base64 decode failed", e);
          return;
        }
        buf = applyPcmS16leGain(buf, tts._outputGain);
        const u8 = new Int8Array(buf);
        for (const frame of bstream.write(u8)) {
          pushFrame(frame, false);
        }
        return;
      }

      if (
        type === "event" &&
        data &&
        (data.event_type === "final" || data.event_type === "Final")
      ) {
        for (const frame of bstream.flush()) {
          pushFrame(frame, true);
        }
        segmentId = shortuuid("seg_");
        onFinal();
        return;
      }
    });

    ttsSocket.on("error", (err) => {
      this.emitError({
        error: err instanceof Error ? err : new Error(String(err)),
        recoverable: true,
      });
      onFinal();
    });

    try {
      for await (const item of this.input) {
        if (this.abortController.signal.aborted) break;
        if (item === SynthesizeStream.FLUSH_SENTINEL) {
          ttsSocket.flush();
          await withFinalTimeout(waitNextFinal(), 6e4);
        } else if (item) {
          ttsSocket.convert(String(item));
        }
      }
    } catch (e) {
      ttsLog("input loop error", e);
      throw e;
    } finally {
      try {
        ttsSocket.close();
      } catch (e) {
        /* ignore */
      }
    }

    this.queue.put(SynthesizeStream.END_OF_STREAM);
  }
}

class SarvamTTSChunked extends ChunkedStream {
  /**
   * @param {SarvamTTS} sarvam
   * @param {string} text
   * @param {import('@livekit/agents').APIConnectOptions} connOptions
   * @param {AbortSignal} [abortSignal]
   */
  constructor(sarvam, text, connOptions, abortSignal) {
    super(text, sarvam, connOptions, abortSignal);
    this._sarvamTts = sarvam;
  }

  get label() {
    return "sarvam.ChunkedStream";
  }

  async run() {
    const tts = this._sarvamTts;
    const text = this.inputText;
    if (!text || !String(text).trim()) {
      this.queue.close();
      return;
    }
    if (!tts._apiKey) {
      throw new APIError("Sarvam TTS: set SARVAM_API_KEY", {
        retryable: false,
      });
    }
    ttsLog("synthesize (chunked) chars=", text.length);

    const client = new SarvamAIClient({ apiSubscriptionKey: tts._apiKey });
    const ttsSocket = await client.textToSpeechStreaming.connect({
      model: tts._model,
      send_completion_event: "true",
      "Api-Subscription-Key": tts._apiKey,
    });
    ttsSocket.connect();
    await ttsSocket.waitForOpen();
    ttsSocket.configureConnection({
      target_language_code: tts._targetLanguageCode,
      speaker: tts._speaker,
      output_audio_codec: "linear16",
      speech_sample_rate: tts._speechSampleRate,
      enable_preprocessing: false,
      loudness: tts._apiLoudness,
    });

    const bstream = new AudioByteStream(tts._speechSampleRate, 1);
    const requestId = shortuuid("tts_");
    const segmentId = shortuuid("seg_");
    const waitFinal = new Promise((resolve, reject) => {
      ttsSocket.on("error", (err) => {
        reject(
          err instanceof Error ? err : new Error(String(err && err.message)),
        );
      });
      ttsSocket.on("message", (raw) => {
        try {
          const msg = normalizeTtsMessage(raw);
          if (msg.type === "audio" && msg.data && msg.data.audio) {
            const raw = Buffer.from(msg.data.audio, "base64");
            const buf = applyPcmS16leGain(raw, tts._outputGain);
            const u8 = new Int8Array(buf);
            for (const frame of bstream.write(u8)) {
              this.queue.put({ requestId, segmentId, frame, final: false });
            }
          } else if (
            msg.type === "event" &&
            msg.data &&
            (msg.data.event_type === "final" || msg.data.event_type === "Final")
          ) {
            for (const frame of bstream.flush()) {
              this.queue.put({ requestId, segmentId, frame, final: true });
            }
            resolve();
          } else if (msg.type === "error" && msg.data) {
            reject(
              new APIError(
                (msg.data && msg.data.message) || "Sarvam TTS error",
                { retryable: true },
              ),
            );
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    ttsSocket.convert(String(text).trim());
    ttsSocket.flush();
    const timeout = new Promise((_, r) =>
      setTimeout(
        () =>
          r(new APIError("Sarvam TTS timeout (chunked)", { retryable: true })),
        45e3,
      ),
    );
    await Promise.race([waitFinal, timeout]);
    try {
      ttsSocket.close();
    } catch (e) {
      /* ignore */
    }
    this.queue.close();
  }
}

function useSamvaadVoiceLlmPipeline() {
  const v = process.env.USE_SAMVAAD_VOICE_LLM;
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

module.exports = { SarvamTTS, useSamvaadVoiceLlmPipeline };
