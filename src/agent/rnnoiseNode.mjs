/**
 * Node.js wrapper for @timephy/rnnoise-wasm. RNNoise expects 480 Float32 samples per frame.
 * Use for pipeline: Exotel (8k) -> resample 8k->48k -> RNNoise -> resample 48k->24k -> STT.
 */

const FRAME_SAMPLES = 480;
const BYTES_PER_SAMPLE = 2;

let processor = null;

async function getProcessor() {
  if (processor) return processor;
  const createSync = (await import("../../node_modules/@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js")).default;
  const RnnoiseProcessor = (await import("../../node_modules/@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js")).default;
  const wasm = createSync();
  processor = new RnnoiseProcessor(wasm);
  return processor;
}

/**
 * Convert Int16 LE buffer (48 kHz) to Float32 in -1..1.
 */
function int16ToFloat32(buffer) {
  const n = buffer.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Write Float32 -1..1 to Int16 LE buffer.
 */
function float32ToInt16(float32Array, buffer) {
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(s < 0 ? s * 32768 : s * 32767, i * 2);
  }
}

/**
 * Process 48 kHz 16-bit LE PCM in place (denoise). Buffer length must be multiple of 480*2 bytes.
 * Processor must already be loaded (e.g. via createBufferedProcessor or getProcessor).
 */
function processPcm48kInt16Sync(buffer, proc) {
  if (buffer.length % (FRAME_SAMPLES * BYTES_PER_SAMPLE) !== 0) {
    throw new Error(`RNNoise: buffer length must be multiple of ${FRAME_SAMPLES * BYTES_PER_SAMPLE}, got ${buffer.length}`);
  }
  const numSamples = buffer.length / 2;
  const floatView = int16ToFloat32(buffer);
  for (let i = 0; i < numSamples; i += FRAME_SAMPLES) {
    const frame = floatView.subarray(i, i + FRAME_SAMPLES);
    proc.processAudioFrame(frame, true);
  }
  float32ToInt16(floatView, buffer);
  return buffer;
}

/**
 * Process 48 kHz 16-bit LE PCM (denoise). Async only for initial WASM load.
 */
export async function processPcm48kInt16(buffer) {
  const proc = await getProcessor();
  return processPcm48kInt16Sync(buffer, proc);
}

const FRAME_BYTES = FRAME_SAMPLES * BYTES_PER_SAMPLE;

/**
 * Create a stateful processor that buffers incomplete frames and returns only full denoised 48k chunks.
 * Use: push(pcm48kInt16Chunk) -> returns array of denoised 48k Int16 Buffers (may be empty). push is sync.
 */
export async function createBufferedProcessor() {
  const proc = await getProcessor();
  let leftover = Buffer.alloc(0);

  return {
    /**
     * Push a chunk of 48 kHz 16-bit LE PCM. Returns an array of full denoised Buffers (48k). Sync.
     */
    push(pcm48kChunk) {
      leftover = Buffer.concat([leftover, pcm48kChunk]);
      const out = [];
      while (leftover.length >= FRAME_BYTES) {
        const numFrames = Math.floor(leftover.length / FRAME_BYTES);
        const toProcess = leftover.subarray(0, numFrames * FRAME_BYTES);
        leftover = leftover.subarray(numFrames * FRAME_BYTES);
        const copy = Buffer.from(toProcess);
        processPcm48kInt16Sync(copy, proc);
        out.push(copy);
      }
      return out;
    },
    flush() {
      leftover = Buffer.alloc(0);
    },
  };
}

export { FRAME_SAMPLES, getProcessor };
