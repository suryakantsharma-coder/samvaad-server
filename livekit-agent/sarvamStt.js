const agents = require("@livekit/agents");
const { STT, SpeechStream, SpeechEventType } = agents.stt;
const { mergeFrames } = agents;

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

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
 * Batch STT via Sarvam REST API; used with Silero VAD + LiveKit StreamAdapter.
 */
class SarvamSTT extends STT {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model] default saaras:v3
   * @param {string} [opts.languageCode] BCP-47 e.g. unknown, hi-IN, gu-IN
   * @param {string} [opts.mode] transcribe | translate | verbatim | translit | codemix (saaras:v3)
   */
  constructor(opts = {}) {
    super({ streaming: false, interimResults: false });
    this.label = "sarvam.STT";
    this._apiKey = opts.apiKey || process.env.SARVAM_API_KEY;
    this._model = opts.model || process.env.SARVAM_STT_MODEL || "saaras:v3";
    this._languageCode =
      opts.languageCode || process.env.SARVAM_LANGUAGE_CODE || "unknown";
    this._mode = opts.mode || process.env.SARVAM_STT_MODE || "transcribe";
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

    const frame = mergeFrames(buffer);
    if (frame.samplesPerChannel === 0) {
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
      throw new Error(`Sarvam STT HTTP ${res.status}: ${msg}`);
    }

    const text = typeof body.transcript === "string" ? body.transcript : "";
    const lang = toLkLanguage(body.language_code);

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

  stream(options) {
    return new SarvamPlaceholderSpeechStream(this, options?.connOptions);
  }
}

class SarvamPlaceholderSpeechStream extends SpeechStream {
  constructor(stt, connOptions) {
    super(stt, undefined, connOptions);
    this.label = "sarvam.STT.unused-stream";
  }

  async run() {
    /* Inner STT is only used through StreamAdapter.recognize(); stream() is never invoked. */
  }
}

module.exports = { SarvamSTT };
