/** @type {Promise<unknown> | null} */
let sharedVadPromise = null;

/**
 * Load Silero VAD once per worker child process (prewarm + entry reuse).
 * @param {import("@livekit/agents").JobProcess<{ vad?: unknown }> | null | undefined} proc
 * @param {{ sampleRate: number, minSilenceDuration: number, prefixPaddingDuration: number }} opts
 */
async function loadSileroVadForProcess(proc, opts) {
  if (proc && proc.userData && proc.userData.vad) {
    return proc.userData.vad;
  }
  if (!sharedVadPromise) {
    const { VAD } = require("@livekit/agents-plugin-silero");
    sharedVadPromise = VAD.load(opts);
  }
  const vad = await sharedVadPromise;
  if (proc) {
    if (!proc.userData) proc.userData = {};
    proc.userData.vad = vad;
  }
  return vad;
}

module.exports = { loadSileroVadForProcess };
