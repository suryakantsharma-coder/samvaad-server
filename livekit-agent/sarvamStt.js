const agents = require("@livekit/agents");
const { STT, SpeechStream, SpeechEventType } = agents.stt;
const { APIConnectionError } = agents;
const { mergeFrames } = agents;
const { SarvamAIClient } = require("sarvamai");

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

/**
 * Log Sarvam STT activity to the terminal.
 * Set SARVAM_STT_DEBUG=0 to disable.
 */
function sttLog(...args) {
  const off = process.env.SARVAM_STT_DEBUG === "0" || process.env.SARVAM_STT_DEBUG === "false";
  if (off) return;
  // eslint-disable-next-line no-console
  console.log("[Sarvam STT]", ...args);
}

function sttWarn(...args) {
  const off = process.env.SARVAM_STT_DEBUG === "0" || process.env.SARVAM_STT_DEBUG === "false";
  if (off) return;
  // eslint-disable-next-line no-console
  console.warn("[Sarvam STT]", ...args);
}

/**
 * Default: WebSocket streaming in production (lower CPU — no Silero batch REST per utterance).
 * Set SARVAM_STT_STREAMING=0 to force batch REST + Silero VAD.
 */
function useWebSocketStreaming() {
  const v = process.env.SARVAM_STT_STREAMING;
  if (v == null || String(v).trim() === "") {
    return process.env.NODE_ENV === "production";
  }
  const s = String(v).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "no" || s === "off" || s === "batch") {
    return false;
  }
  return s === "1" || s === "true" || s === "yes" || s === "ws" || s === "stream";
}

/** Normalize Sarvam WS JSON (snake_case / camelCase / shapes). */
function normalizeSarvamWsMessage(raw) {
  if (!raw || typeof raw !== "object") return { type: undefined, data: undefined };
  const type = raw.type ?? raw.Type;
  let data = raw.data ?? raw.Data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const m = data.metrics ?? data.Metrics;
    const audioDur = m && (m.audio_duration ?? m.audioDuration);
    data = {
      ...data,
      transcript:
        typeof data.transcript === "string"
          ? data.transcript
          : typeof data.Transcript === "string"
            ? data.Transcript
            : undefined,
      error: data.error ?? data.Error,
      code: data.code ?? data.Code,
      signal_type: data.signal_type ?? data.signalType ?? data.SignalType,
      request_id: data.request_id ?? data.requestId,
      language_code: data.language_code ?? data.languageCode,
      metrics:
        m && typeof audioDur === "number"
          ? { ...m, audio_duration: audioDur }
          : m,
    };
  }
  return { type, data };
}

/** Map Sarvam BCP-47 codes to LiveKit language tags where possible. */
function toLkLanguage(code) {
  if (!code || code === "unknown") return "hi";
  const base = String(code).split("-")[0];
  return base || "hi";
}

function int16PcmToWavBuffer(int16, sampleRate, channels) {
  const dataSize = int16.byteLength;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  Buffer.from(
    int16.buffer,
    int16.byteOffset,
    int16.byteLength,
  ).copy(out, 44);
  return out;
}

/**
 * Sarvam STT: WebSocket streaming (opt-in) or REST batch + Silero (default).
 */
class SarvamSTT extends STT {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model] default saaras:v3
   * @param {string} [opts.languageCode] BCP-47 e.g. unknown, hi-IN, gu-IN
   * @param {string} [opts.mode] transcribe | translate | verbatim | translit | codemix (REST only)
   * @param {boolean} [opts.useWebSocketStreaming] override env
   */
  constructor(opts = {}) {
    const ws =
      typeof opts.useWebSocketStreaming === "boolean"
        ? opts.useWebSocketStreaming
        : useWebSocketStreaming();
    super({
      streaming: ws,
      interimResults: ws,
    });
    this.label = "sarvam.STT";
    this._useWebSocketStreaming = ws;
    this._apiKey = opts.apiKey || process.env.SARVAM_API_KEY;
    this._model = opts.model || process.env.SARVAM_STT_MODEL || "saaras:v3";
    this._languageCode =
      opts.languageCode || process.env.SARVAM_LANGUAGE_CODE || "unknown";
    this._mode = opts.mode || process.env.SARVAM_STT_MODE || "transcribe";

    sttLog(
      "init mode=",
      ws ? "websocket_streaming" : "batch_rest_vad",
      "(set SARVAM_STT_STREAMING=1 for WS, or omit/0 for batch)",
    );
  }

  get model() {
    return this._model;
  }

  get provider() {
    return "sarvam";
  }

  /**
   * @param {import('@livekit/agents').AudioBuffer} buffer
   */
  async _recognize(buffer, abortSignal) {
    if (!this._apiKey) {
      throw new Error("Sarvam STT: set SARVAM_API_KEY");
    }

    sttLog("REST _recognize: merging frames…");

    const frame = mergeFrames(buffer);
    if (frame.samplesPerChannel === 0) {
      sttLog("REST _recognize: empty frame");
      return {
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            language: "hi",
            text: "",
            startTime: 0,
            endTime: 0,
            confidence: 0,
          },
        ],
      };
    }

    const wav = int16PcmToWavBuffer(
      frame.data,
      frame.sampleRate,
      frame.channels,
    );

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("model", this._model);
    form.append("language_code", this._languageCode);
    if (String(this._model).includes("saaras")) {
      form.append("mode", this._mode);
    }

    const res = await fetch(SARVAM_STT_URL, {
      method: "POST",
      headers: {
        "api-subscription-key": this._apiKey,
      },
      body: form,
      signal: abortSignal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        body && body.error && body.error.message
          ? body.error.message
          : res.statusText;
      sttWarn("REST error", res.status, msg);
      throw new Error(`Sarvam STT HTTP ${res.status}: ${msg}`);
    }

    const text = typeof body.transcript === "string" ? body.transcript : "";
    const lang = toLkLanguage(body.language_code);
    sttLog("REST final:", text ? `"${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"` : "(empty)");

    return {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      requestId: body.request_id || undefined,
      alternatives: [
        {
          language: lang,
          text,
          startTime: 0,
          endTime: frame.samplesPerChannel / frame.sampleRate,
          confidence: 1,
        },
      ],
    };
  }

  /**
   * @param {{ connOptions?: import('@livekit/agents').APIConnectOptions }} [options]
   */
  stream(options) {
    if (this._useWebSocketStreaming) {
      return new SarvamStreamingSpeechStream(
        this,
        options == null ? void 0 : options.connOptions,
      );
    }
    return new SarvamBatchPlaceholderSpeechStream(
      this,
      options == null ? void 0 : options.connOptions,
    );
  }
}

class SarvamBatchPlaceholderSpeechStream extends SpeechStream {
  constructor(stt, connOptions) {
    super(stt, undefined, connOptions);
    this.label = "sarvam.STT.batch-adapter";
  }

  async run() {
    sttLog("batch path: stream.run() is idle; StreamAdapter+VAD use _recognize() only");
  }
}

class SarvamStreamingSpeechStream extends SpeechStream {
  /**
   * @param {SarvamSTT} stt
   * @param {import('@livekit/agents').APIConnectOptions} [connOptions]
   */
  constructor(stt, connOptions) {
    super(stt, 16000, connOptions);
    this._stt = stt;
  }

  get label() {
    return "sarvam.STT.stream";
  }

  /** Send raw s16le PCM; connection must use input_audio_codec=pcm_s16le. */
  _sendPcmFrame(sttSocket, item) {
    const u8 = new Uint8Array(
      item.data.buffer,
      item.data.byteOffset,
      item.data.byteLength,
    );
    const b64 = Buffer.from(u8).toString("base64");
    const payload = JSON.stringify({
      audio: {
        data: b64,
        sample_rate: 16000,
        encoding: "pcm_s16le",
      },
    });
    sttSocket.socket.send(payload);
  }

  async run() {
    const apiKey = this._stt._apiKey;
    if (!apiKey) {
      throw new Error("Sarvam STT: set SARVAM_API_KEY");
    }

    sttLog("WebSocket: connecting…", {
      model: this._stt._model,
      "language-code": this._stt._languageCode,
    });

    const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    const sttSocket = await client.speechToTextStreaming.connect({
      "language-code": this._stt._languageCode,
      model: this._stt._model,
      sample_rate: "16000",
      input_audio_codec: "pcm_s16le",
      high_vad_sensitivity: "true",
      vad_signals: "true",
      flush_signal: "true",
      "Api-Subscription-Key": apiKey,
    });

    sttSocket.connect();
    await sttSocket.waitForOpen();
    sttLog("WebSocket: open, streaming PCM s16le @ 16kHz");

    let lastTranscript = "";
    let lastRequestId;
    let lastAudioDuration = 0;
    let lastLanguage = "hi";
    let segmentOpen = false;
    const queue = this.queue;
    /** @type {Error|null} */
    let streamErr = null;
    let frameCount = 0;

    const putEvent = (ev) => {
      if (queue.closed) return;
      try {
        queue.put(ev);
        const t = ev.type;
        const name =
          t === SpeechEventType.START_OF_SPEECH
            ? "START_OF_SPEECH"
            : t === SpeechEventType.INTERIM_TRANSCRIPT
              ? "INTERIM_TRANSCRIPT"
              : t === SpeechEventType.FINAL_TRANSCRIPT
                ? "FINAL_TRANSCRIPT"
                : t === SpeechEventType.END_OF_SPEECH
                  ? "END_OF_SPEECH"
                  : t === SpeechEventType.RECOGNITION_USAGE
                    ? "RECOGNITION_USAGE"
                    : String(t);
        const first =
          ev.alternatives && ev.alternatives[0] && ev.alternatives[0].text
            ? String(ev.alternatives[0].text).slice(0, 200)
            : "";
        sttLog("→ LiveKit", name, first ? `text="${first}${first.length >= 200 ? "…" : ""}"` : "");
      } catch (e) {
        if (e instanceof Error && e.message.includes("Queue is closed")) {
          return;
        }
        throw e;
      }
    };

    const onMessage = (rawMessage) => {
      if (queue.closed || this.abortController.signal.aborted) return;

      const { type, data: rawData } = normalizeSarvamWsMessage(rawMessage);
      const data = rawData;
      sttLog("← Sarvam WS", "type=" + type, data ? safeJsonForLog({ ...data, transcript: data.transcript ? `${String(data.transcript).slice(0, 80)}…` : data.transcript }) : "");

      if (!type) return;

      if (
        type === "error" ||
        (data && typeof data.error === "string" && !("transcript" in data))
      ) {
        const errMsg =
          (data && data.error) || "Sarvam streaming STT error";
        sttWarn("WS error frame:", errMsg);
        streamErr = new APIConnectionError({
          message: String(errMsg),
          options: { retryable: true },
        });
        sttSocket.close();
        return;
      }

      if (type === "events" && data && data.signal_type) {
        if (data.signal_type === "START_SPEECH") {
          if (!segmentOpen) {
            segmentOpen = true;
            putEvent({ type: SpeechEventType.START_OF_SPEECH });
          }
        } else if (data.signal_type === "END_SPEECH") {
          const t = (lastTranscript || "").trim();
          if (t) {
            if (lastAudioDuration > 0) {
              putEvent({
                type: SpeechEventType.RECOGNITION_USAGE,
                requestId: lastRequestId,
                recognitionUsage: { audioDuration: lastAudioDuration },
              });
            }
            putEvent({
              type: SpeechEventType.FINAL_TRANSCRIPT,
              requestId: lastRequestId,
              alternatives: [
                {
                  language: lastLanguage,
                  text: t,
                  startTime: 0,
                  endTime: lastAudioDuration || 0,
                  confidence: 0.9,
                },
              ],
            });
          } else {
            sttLog("END_SPEECH with empty lastTranscript (no FINAL text)");
          }
          if (segmentOpen) {
            segmentOpen = false;
            putEvent({ type: SpeechEventType.END_OF_SPEECH });
          }
          lastTranscript = "";
        }
        return;
      }

      if (type === "data" && data && typeof data.transcript === "string") {
        const text = data.transcript;
        if (data.request_id) lastRequestId = data.request_id;
        if (data.language_code) {
          lastLanguage = toLkLanguage(data.language_code);
        }
        if (data.metrics && typeof data.metrics.audio_duration === "number") {
          lastAudioDuration = data.metrics.audio_duration;
        }
        lastTranscript = text;
        if (!text) return;
        if (!segmentOpen) {
          segmentOpen = true;
          putEvent({ type: SpeechEventType.START_OF_SPEECH });
        }
        putEvent({
          type: SpeechEventType.INTERIM_TRANSCRIPT,
          requestId: lastRequestId,
          alternatives: [
            {
              language: lastLanguage,
              text: text.trim(),
              startTime: 0,
              endTime: lastAudioDuration || 0,
              confidence: 0.5,
            },
          ],
        });
      }
    };

    sttSocket.on("message", (msg) => {
      try {
        onMessage(msg);
      } catch (e) {
        sttWarn("onMessage throw:", e);
        streamErr = e instanceof Error ? e : new Error(String(e));
        sttSocket.close();
      }
    });

    sttSocket.on("error", (err) => {
      sttWarn("socket error event:", err);
      if (this.abortController.signal.aborted) return;
      streamErr = new APIConnectionError({
        message: err && err.message ? err.message : String(err),
        options: { retryable: true },
      });
      try {
        sttSocket.close();
      } catch (e) {
        /* ignore */
      }
    });

    sttSocket.on("close", (ev) => {
      sttLog("WebSocket: closed", ev && (ev.code ?? ev));
    });

    try {
      for await (const item of this.input) {
        if (streamErr) {
          break;
        }
        if (this.abortController.signal.aborted) break;
        if (item === SpeechStream.FLUSH_SENTINEL) {
          sttLog("input: FLUSH → Sarvam flush()");
          try {
            sttSocket.flush();
          } catch (e) {
            if (this.abortController.signal.aborted) break;
            throw e;
          }
          continue;
        }
        if (item.samplesPerChannel === 0) continue;

        frameCount += 1;
        if (frameCount === 1 || frameCount % 200 === 0) {
          sttLog("audio in: frames sent=", frameCount, "samples/ch=", item.samplesPerChannel);
        }

        this._sendPcmFrame(sttSocket, item);
      }
    } finally {
      sttLog("input loop ended, frames total=", frameCount);
      try {
        sttSocket.close();
      } catch (e) {
        /* ignore */
      }
    }

    if (streamErr) {
      sttWarn("run() fails:", streamErr.message);
      throw streamErr;
    }
  }
}

function safeJsonForLog(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

module.exports = { SarvamSTT, sttLog, useWebSocketStreaming };
