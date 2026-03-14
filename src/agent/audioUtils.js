/**
 * Audio constants and PCM helpers for Exotel (8kHz) <-> OpenAI Realtime (24kHz).
 */

const EXOTEL_SAMPLE_RATE = 8000;
const EXOTEL_SAMPLE_WIDTH = 2;
const EXOTEL_CHUNK_MS = 20;
const EXOTEL_CHUNK_BYTES =
  ((EXOTEL_SAMPLE_RATE * EXOTEL_CHUNK_MS) / 1000) * EXOTEL_SAMPLE_WIDTH;

const OPENAI_SAMPLE_RATE = 24000;
const OPENAI_SAMPLE_WIDTH = 2;

const RESAMPLE_UP = OPENAI_SAMPLE_RATE / EXOTEL_SAMPLE_RATE;
const RESAMPLE_DOWN = EXOTEL_SAMPLE_RATE / OPENAI_SAMPLE_RATE;

function resample8kTo24k(pcm8k) {
  const numSamples8k = pcm8k.length / 2;
  const numSamples24k = Math.floor(numSamples8k * RESAMPLE_UP);
  const out = Buffer.alloc(numSamples24k * 2);
  for (let i = 0; i < numSamples24k; i++) {
    const srcIdx = i / RESAMPLE_UP;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, numSamples8k - 1);
    const frac = srcIdx - i0;
    const s0 = pcm8k.readInt16LE(i0 * 2);
    const s1 = pcm8k.readInt16LE(i1 * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function resample24kTo8k(pcm24k) {
  const numSamples24k = pcm24k.length / 2;
  const numSamples8k = Math.floor(numSamples24k * RESAMPLE_DOWN);
  const out = Buffer.alloc(numSamples8k * 2);
  for (let i = 0; i < numSamples8k; i++) {
    const srcIdx = i * RESAMPLE_UP;
    const idx = Math.min(Math.floor(srcIdx), numSamples24k - 1);
    const sample = pcm24k.readInt16LE(idx * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

const SAMPLE_RATE_48K = 48000;
const RESAMPLE_24_TO_48 = SAMPLE_RATE_48K / OPENAI_SAMPLE_RATE;
const RESAMPLE_48_TO_24 = OPENAI_SAMPLE_RATE / SAMPLE_RATE_48K;

function resample8kTo48k(pcm8k) {
  const pcm24k = resample8kTo24k(pcm8k);
  const n24 = pcm24k.length / 2;
  const n48 = Math.floor(n24 * RESAMPLE_24_TO_48);
  const out = Buffer.alloc(n48 * 2);
  for (let i = 0; i < n48; i++) {
    const srcIdx = i / RESAMPLE_24_TO_48;
    const i0 = Math.min(Math.floor(srcIdx), n24 - 1);
    const sample = pcm24k.readInt16LE(i0 * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function resample48kTo24k(pcm48k) {
  const n48 = pcm48k.length / 2;
  const n24 = Math.floor(n48 * RESAMPLE_48_TO_24);
  const out = Buffer.alloc(n24 * 2);
  for (let i = 0; i < n24; i++) {
    const idx = Math.min(Math.floor(i / RESAMPLE_48_TO_24), n48 - 1);
    const sample = pcm48k.readInt16LE(idx * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function pcm24kToWavBuffer(pcm24k) {
  const numSamples = pcm24k.length / 2;
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm24k]);
}

function computeRms(pcmBuffer) {
  let sum = 0;
  const n = pcmBuffer.length / 2;
  for (let i = 0; i < n; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    sum += s * s;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

const NOISE_GATE_THRESHOLD = 180;

/** RNNoise (@timephy/rnnoise-wasm) expects 44.1kHz Float32, 480 samples per frame. */
const RNNOISE_SAMPLE_RATE = 44100;
const RNNOISE_FRAME_SAMPLES = 480;
const RESAMPLE_24_TO_44100 = RNNOISE_SAMPLE_RATE / OPENAI_SAMPLE_RATE;
const RESAMPLE_44100_TO_24 = OPENAI_SAMPLE_RATE / RNNOISE_SAMPLE_RATE;
const INT16_TO_FLOAT = 1 / 32768;

/**
 * Resample 24kHz 16-bit LE PCM to 44.1kHz Float32 in [-1, 1] for RNNoise.
 * @param {Buffer} pcm24k - 16-bit LE PCM at 24kHz
 * @returns {Float32Array} Float32 at 44.1kHz
 */
function pcm24kTo44kFloat32(pcm24k) {
  const n24 = pcm24k.length / 2;
  const n44 = Math.floor(n24 * RESAMPLE_24_TO_44100);
  const out = new Float32Array(n44);
  for (let i = 0; i < n44; i++) {
    const srcIdx = i / RESAMPLE_24_TO_44100;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, n24 - 1);
    const frac = srcIdx - i0;
    const s0 = pcm24k.readInt16LE(i0 * 2) * INT16_TO_FLOAT;
    const s1 = pcm24k.readInt16LE(i1 * 2) * INT16_TO_FLOAT;
    out[i] = s0 + frac * (s1 - s0);
  }
  return out;
}

/**
 * Resample 44.1kHz Float32 in [-1, 1] back to 24kHz 16-bit LE PCM.
 * @param {Float32Array} f32 - Float32 at 44.1kHz
 * @param {number} [outSamples] - If set, clamp output to this many samples (for padded frames).
 * @returns {Buffer} 16-bit LE PCM at 24kHz
 */
function float32_44kToPcm24k(f32, outSamples) {
  const n44 = f32.length;
  const n24 = outSamples != null ? outSamples : Math.floor(n44 * RESAMPLE_44100_TO_24);
  const out = Buffer.alloc(n24 * 2);
  for (let i = 0; i < n24; i++) {
    const srcIdx = i / RESAMPLE_44100_TO_24;
    const idx = Math.min(Math.floor(srcIdx), n44 - 1);
    const s = Math.max(-1, Math.min(1, f32[idx]));
    out.writeInt16LE(s >= 0 ? Math.min(32767, Math.round(s * 32767)) : Math.max(-32768, Math.round(s * 32768)), i * 2);
  }
  return out;
}

function applyNoiseReduction(pcm24k) {
  const frameMs = 20;
  const frameBytes =
    (frameMs / 1000) * OPENAI_SAMPLE_RATE * OPENAI_SAMPLE_WIDTH;
  const out = Buffer.from(pcm24k);
  for (let i = 0; i < out.length; i += frameBytes) {
    const frame = out.subarray(i, Math.min(i + frameBytes, out.length));
    const rms = computeRms(frame);
    if (rms < NOISE_GATE_THRESHOLD) {
      frame.fill(0);
    }
  }
  return out;
}

module.exports = {
  resample8kTo24k,
  resample24kTo8k,
  resample8kTo48k,
  resample48kTo24k,
  pcm24kToWavBuffer,
  pcm24kTo44kFloat32,
  float32_44kToPcm24k,
  computeRms,
  applyNoiseReduction,
  EXOTEL_CHUNK_BYTES,
  OPENAI_SAMPLE_RATE,
  OPENAI_SAMPLE_WIDTH,
  RNNOISE_SAMPLE_RATE,
  RNNOISE_FRAME_SAMPLES,
};
