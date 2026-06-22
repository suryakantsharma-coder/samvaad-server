/**
 * Controls whether index.js spawns embedded LiveKit / queue child processes.
 *
 * Production (PM2): voice workers run in dedicated apps — see ecosystem.config.cjs.
 * Development: embedded workers start by default when configured.
 */

function isTruthy(v) {
  if (v == null || v === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * @param {{ disabledEnv: string, embeddedEnv: string, workerLabel: string }} opts
 */
function shouldEmbedWorker(opts) {
  const { disabledEnv, embeddedEnv, workerLabel } = opts;

  if (isTruthy(process.env[disabledEnv])) {
    return { embed: false, reason: `${disabledEnv} is set` };
  }

  if (process.env.NODE_ENV === "production") {
    if (isTruthy(process.env[embeddedEnv])) {
      return { embed: true, reason: `${embeddedEnv} is set` };
    }
    return {
      embed: false,
      reason: `production — run ${workerLabel} as a separate PM2 process (or set ${embeddedEnv}=1 to embed in API)`,
    };
  }

  return { embed: true, reason: "development" };
}

function shouldEmbedLiveKitWorker() {
  return shouldEmbedWorker({
    disabledEnv: "LIVEKIT_WORKER_DISABLED",
    embeddedEnv: "LIVEKIT_WORKER_EMBEDDED",
    workerLabel: "samvaad-livekit-worker",
  });
}

function shouldEmbedQueueWorker() {
  if (!isTruthy(process.env.LIVEKIT_QUEUE_ENABLED)) {
    return { embed: false, reason: "LIVEKIT_QUEUE_ENABLED not set" };
  }

  return shouldEmbedWorker({
    disabledEnv: "QUEUE_WORKER_DISABLED",
    embeddedEnv: "QUEUE_WORKER_EMBEDDED",
    workerLabel: "samvaad-queue-worker",
  });
}

module.exports = {
  shouldEmbedLiveKitWorker,
  shouldEmbedQueueWorker,
};
