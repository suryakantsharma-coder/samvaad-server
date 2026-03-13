/**
 * Acoustic Echo Cancellation (AEC): NLMS filter + reference ring buffer.
 * Pure JS. Use per-call: pushReference(outbound 8kHz PCM), processInbound(inbound 8kHz) -> cleaned.
 */

const EXOTEL_SAMPLE_RATE = 8000;
const EXOTEL_SAMPLE_WIDTH = 2;

function createEchoCanceller(options) {
  const {
    useAec = true,
    delayMs = 100,
    filterLength = 128,
    referenceBufferMs = 400,
  } = options || {};

  const refBufBytes =
    Math.ceil(
      (referenceBufferMs / 1000) * EXOTEL_SAMPLE_RATE * EXOTEL_SAMPLE_WIDTH,
    ) || 6400;
  const refBuf = Buffer.alloc(refBufBytes);
  let refWriteIdx = 0;
  let refTotalPushed = 0;

  const delaySamples = Math.round((delayMs / 1000) * EXOTEL_SAMPLE_RATE);
  const filterLen = filterLength;
  const minRefSamples = delaySamples + filterLen + 160;
  const w = new Float64Array(filterLen);
  const mu = 0.15;
  const eps = 1e-8;

  function readInt16LE(buf, byteIdx, size) {
    const lo = buf[byteIdx % size];
    const hi = buf[(byteIdx + 1) % size];
    const s = lo | (hi << 8);
    return s > 32767 ? s - 65536 : s;
  }

  return {
    pushReference(pcm8kChunk) {
      if (!pcm8kChunk || pcm8kChunk.length === 0) return;
      const n = pcm8kChunk.length;
      for (let i = 0; i < n; i++) {
        refBuf[refWriteIdx] = pcm8kChunk[i];
        refWriteIdx = (refWriteIdx + 1) % refBufBytes;
      }
      refTotalPushed += n;
    },
    processInbound(pcm8k) {
      if (!useAec || !pcm8k || pcm8k.length === 0) return pcm8k;
      const numSamples = pcm8k.length >> 1;
      if (refTotalPushed < minRefSamples * 2) return pcm8k;

      const out = Buffer.alloc(pcm8k.length);

      for (let i = 0; i < numSamples; i++) {
        const d = pcm8k.readInt16LE(i * 2);
        const refStart =
          (refWriteIdx -
            (delaySamples + filterLen - i) * 2 +
            refBufBytes * 2) %
          refBufBytes;

        let y = 0;
        for (let k = 0; k < filterLen; k++) {
          const byteIdx = refStart + k * 2;
          const xk = readInt16LE(refBuf, byteIdx, refBufBytes);
          y += w[k] * xk;
        }
        const e = d - y;

        let norm = eps;
        for (let k = 0; k < filterLen; k++) {
          const byteIdx = refStart + k * 2;
          const xkSigned = readInt16LE(refBuf, byteIdx, refBufBytes);
          norm += xkSigned * xkSigned;
        }
        const step = (mu * e) / norm;
        for (let k = 0; k < filterLen; k++) {
          const byteIdx = refStart + k * 2;
          const xkSigned = readInt16LE(refBuf, byteIdx, refBufBytes);
          w[k] += step * xkSigned;
        }

        const outSample = Math.max(-32768, Math.min(32767, Math.round(e)));
        out.writeInt16LE(outSample, i * 2);
      }
      return out;
    },
  };
}

module.exports = { createEchoCanceller };
