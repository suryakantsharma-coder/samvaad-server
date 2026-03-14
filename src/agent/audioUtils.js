/**
 * Audio utilities for Exotel/OpenAI Realtime bridge: resampling, WAV, RMS, noise gate.
 */

const EXOTEL_SAMPLE_RATE = 8000;
const EXOTEL_SAMPLE_WIDTH = 2;
const EXOTEL_CHUNK_MS = 20;
const EXOTEL_CHUNK_BYTES =
  ((EXOTEL_SAMPLE_RATE * EXOTEL_CHUNK_MS) / 1000) * EXOTEL_SAMPLE_WIDTH;

const OPENAI_SAMPLE_RATE = 24000;
const OPENAI_SAMPLE_WIDTH = 2;

/** RNNoise operates at 48 kHz, 480 samples per frame (10 ms). */
const RNNOISE_SAMPLE_RATE = 48000;
const RNNOISE_FRAME_SAMPLES = 480;

const RESAMPLE_UP = OPENAI_SAMPLE_RATE / EXOTEL_SAMPLE_RATE;
const RESAMPLE_DOWN = EXOTEL_SAMPLE_RATE / OPENAI_SAMPLE_RATE;
const RESAMPLE_8K_TO_48K = RNNOISE_SAMPLE_RATE / EXOTEL_SAMPLE_RATE;
const RESAMPLE_48K_TO_24K = OPENAI_SAMPLE_RATE / RNNOISE_SAMPLE_RATE;

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
    out.writeInt16LE(Math.round(s0 + frac * (s1 - s0)), i * 2);
  }
  return out;
}

function resample24kTo8k(pcm24k) {
  const numSamples24k = pcm24k.length / 2;
  const numSamples8k = Math.floor(numSamples24k * RESAMPLE_DOWN);
  const out = Buffer.alloc(numSamples8k * 2);
  for (let i = 0; i < numSamples8k; i++) {
    const idx = Math.min(
      Math.floor(i * RESAMPLE_UP),
      numSamples24k - 1,
    );
    out.writeInt16LE(pcm24k.readInt16LE(idx * 2), i * 2);
  }
  return out;
}

/** Resample 8 kHz 16-bit LE PCM to 48 kHz (for RNNoise). */
function resample8kTo48k(pcm8k) {
  const numSamples8k = pcm8k.length / 2;
  const numSamples48k = Math.floor(numSamples8k * RESAMPLE_8K_TO_48K);
  const out = Buffer.alloc(numSamples48k * 2);
  for (let i = 0; i < numSamples48k; i++) {
    const srcIdx = i / RESAMPLE_8K_TO_48K;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, numSamples8k - 1);
    const frac = srcIdx - i0;
    const s0 = pcm8k.readInt16LE(i0 * 2);
    const s1 = pcm8k.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + frac * (s1 - s0)), i * 2);
  }
  return out;
}

/** Resample 48 kHz 16-bit LE PCM to 24 kHz (for STT/OpenAI). */
function resample48kTo24k(pcm48k) {
  const numSamples48k = pcm48k.length / 2;
  const numSamples24k = Math.floor(numSamples48k * RESAMPLE_48K_TO_24K);
  const out = Buffer.alloc(numSamples24k * 2);
  for (let i = 0; i < numSamples24k; i++) {
    const srcIdx = i / RESAMPLE_48K_TO_24K;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, numSamples48k - 1);
    const frac = srcIdx - i0;
    const s0 = pcm48k.readInt16LE(i0 * 2);
    const s1 = pcm48k.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + frac * (s1 - s0)), i * 2);
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

function applyNoiseReduction(pcm24k, sampleRate = 24000, frameMs = 20, threshold = 180) {
  const frameBytes = (frameMs / 1000) * sampleRate * 2;
  const out = Buffer.from(pcm24k);
  for (let i = 0; i < out.length; i += frameBytes) {
    const frame = out.subarray(i, Math.min(i + frameBytes, out.length));
    if (computeRms(frame) < threshold) frame.fill(0);
  }
  return out;
}

module.exports = {
  EXOTEL_SAMPLE_RATE,
  EXOTEL_SAMPLE_WIDTH,
  EXOTEL_CHUNK_MS,
  EXOTEL_CHUNK_BYTES,
  OPENAI_SAMPLE_RATE,
  OPENAI_SAMPLE_WIDTH,
  RNNOISE_SAMPLE_RATE,
  RNNOISE_FRAME_SAMPLES,
  resample8kTo24k,
  resample24kTo8k,
  resample8kTo48k,
  resample48kTo24k,
  pcm24kToWavBuffer,
  computeRms,
  applyNoiseReduction,
};
