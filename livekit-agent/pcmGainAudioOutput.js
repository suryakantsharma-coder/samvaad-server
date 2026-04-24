const path = require("path");
const { AudioFrame } = require("@livekit/rtc-node");
// Not exported from @livekit/agents package entry — load impl file directly
const { AudioOutput } = require(
  path.join(__dirname, "..", "node_modules", "@livekit", "agents", "dist", "voice", "io.cjs"),
);

/**
 * Multiplies signed PCM16 in each AudioFrame before publish. Place **outermost** in the chain
 * (so transcription sync, recording, and SIP all see the same levels as the caller hears).
 */
class PcmGainAudioOutput extends AudioOutput {
  constructor(nextSink, gain) {
    const sr =
      nextSink && nextSink.sampleRate != null ? nextSink.sampleRate : 24_000;
    super(sr, nextSink, { pause: true });
    this._gain = gain;
  }

  /**
   * @param {import("@livekit/rtc-node").AudioFrame} frame
   */
  async captureFrame(frame) {
    await super.captureFrame(frame);
    const g = this._gain;
    const next = this.nextInChain;
    if (!next) return;
    if (!g || g === 1) {
      await next.captureFrame(frame);
      return;
    }
    const data = frame.data;
    const n = data.length;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.round(data[i] * g);
      out[i] = Math.max(-32_768, Math.min(32_767, v));
    }
    const boosted = new AudioFrame(
      out,
      frame.sampleRate,
      frame.channels,
      frame.samplesPerChannel,
    );
    await next.captureFrame(boosted);
  }

  flush() {
    super.flush();
    this.nextInChain?.flush();
  }

  clearBuffer() {
    this.nextInChain?.clearBuffer();
  }
}

function parseEnvGain(name) {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const g = Number(raw);
  if (!Number.isFinite(g) || g <= 0) return null;
  return Math.min(6, Math.max(0.5, g));
}

/**
 * - LIVEKIT_AGENT_OUTPUT_PCM_GAIN: applies to **every** voice pipeline (optional; overrides the rest).
 * - OPENAI_REALTIME_OUTPUT_PCM_GAIN: when LIVEKIT… is unset, used only for **OpenAI Realtime** TTS
 *   (Sarvam STT → Realtime). Default 1.85 if unset.
 * - Samvaad (Sarvam TTS) path: default outer gain is 1 (use SARVAM_TTS_GAIN for loudness).
 */
function getAgentOutputPcmGain(useSamvaadLlmTts) {
  const global = parseEnvGain("LIVEKIT_AGENT_OUTPUT_PCM_GAIN");
  if (global != null) return global;
  if (useSamvaadLlmTts) {
    return 1;
  }
  const o = parseEnvGain("OPENAI_REALTIME_OUTPUT_PCM_GAIN");
  if (o != null) return o;
  return 1.85;
}

module.exports = {
  PcmGainAudioOutput,
  getAgentOutputPcmGain,
};
