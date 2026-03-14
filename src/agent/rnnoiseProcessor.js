/**
 * RNNoise noise suppression between Exotel and Sarvam STT.
 * Uses @timephy/rnnoise-wasm (44.1kHz Float32, 480 samples/frame).
 * Converts 24kHz 16-bit PCM <-> 44.1kHz Float32 and processes in frames.
 */

const path = require("path");
const { pathToFileURL } = require("url");
const {
  pcm24kTo44kFloat32,
  float32_44kToPcm24k,
  RNNOISE_FRAME_SAMPLES,
} = require("./audioUtils");

let wasmModule = null;
let RnnoiseProcessorClass = null;
let initPromise = null;

/** Polyfills required by @timephy/rnnoise-wasm in Node. */
function applyPolyfills() {
  if (typeof globalThis.self === "undefined") {
    globalThis.self = { location: { href: "" } };
  }
  if (typeof globalThis.atob === "undefined") {
    globalThis.atob = (str) => Buffer.from(String(str), "base64").toString("binary");
  }
}

/**
 * Load WASM module and RnnoiseProcessor (ESM) once. Thread-safe via single promise.
 * @returns {Promise<{ processor: InstanceType<RnnoiseProcessor>, destroy: () => void }>}
 */
async function loadRnnoise() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    applyPolyfills();
    const base = path.join(__dirname, "..", "..", "node_modules", "@timephy", "rnnoise-wasm", "dist");
    const syncPath = pathToFileURL(path.join(base, "generated", "rnnoise-sync.js")).href;
    const processorPath = pathToFileURL(path.join(base, "RnnoiseProcessor.js")).href;

    const createSync = (await import(syncPath)).default;
    const { default: RnnoiseProcessor } = await import(processorPath);

    wasmModule = createSync();
    const processor = new RnnoiseProcessor(wasmModule);

    return {
      processor,
      destroy() {
        try {
          processor.destroy();
        } catch (e) {
          console.error("[RNNoise] destroy error:", e.message);
        }
      },
    };
  })();
  return initPromise;
}

/**
 * Process 24kHz 16-bit LE PCM through RNNoise; returns denoised 24kHz 16-bit PCM.
 * Frames are 480 samples at 44.1kHz; input is resampled, processed, then resampled back.
 * @param {Buffer} pcm24k - 16-bit LE PCM at 24kHz
 * @param {{ processor: { processAudioFrame: (Float32Array, boolean) => number }, destroy: () => void }} rnnoise - from loadRnnoise()
 * @returns {Buffer} Denoised 16-bit LE PCM at 24kHz (same length as input)
 */
function processPcm24kWithRnnoise(pcm24k, rnnoise) {
  const n24 = pcm24k.length / 2;
  if (n24 === 0) return pcm24k;

  const f32 = pcm24kTo44kFloat32(pcm24k);
  const n44 = f32.length;
  const numFrames = Math.ceil(n44 / RNNOISE_FRAME_SAMPLES);
  const paddedLen = numFrames * RNNOISE_FRAME_SAMPLES;
  const padded = new Float32Array(paddedLen);
  padded.set(f32);
  for (let i = n44; i < paddedLen; i++) padded[i] = 0;

  const frame = new Float32Array(RNNOISE_FRAME_SAMPLES);
  for (let f = 0; f < numFrames; f++) {
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) {
      frame[i] = padded[f * RNNOISE_FRAME_SAMPLES + i];
    }
    rnnoise.processor.processAudioFrame(frame, true);
    for (let i = 0; i < RNNOISE_FRAME_SAMPLES; i++) {
      padded[f * RNNOISE_FRAME_SAMPLES + i] = frame[i];
    }
  }

  return float32_44kToPcm24k(padded, n24);
}

module.exports = {
  loadRnnoise,
  processPcm24kWithRnnoise,
};
