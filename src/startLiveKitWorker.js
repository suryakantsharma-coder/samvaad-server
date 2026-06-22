const { spawn } = require("child_process");
const path = require("path");
const { shouldEmbedLiveKitWorker } = require("./workerEmbedPolicy");

let child = null;
let intentionalShutdown = false;
let restartTimer = null;
let restartAttempts = 0;

const MAX_RESTART_ATTEMPTS = 10;
const BASE_RESTART_MS = 1000;
const MAX_RESTART_MS = 30000;

function isConfigured() {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

function clearRestartTimer() {
  if (restartTimer != null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleWorkerRestart(code, signal) {
  if (intentionalShutdown) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[Samvaad] LiveKit worker restart limit reached (${MAX_RESTART_ATTEMPTS}); not restarting`,
    );
    return;
  }

  const delay = Math.min(
    MAX_RESTART_MS,
    BASE_RESTART_MS * 2 ** restartAttempts,
  );
  restartAttempts += 1;
  console.warn(
    `[Samvaad] LiveKit worker will restart in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})` +
      (signal ? ` after signal ${signal}` : code != null ? ` after exit ${code}` : ""),
  );

  clearRestartTimer();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (intentionalShutdown) return;
    spawnWorker();
  }, delay);
}

function spawnWorker() {
  const mode = process.env.NODE_ENV === "production" ? "start" : "dev";
  const mainJs = path.join(__dirname, "..", "livekit-agent", "main.js");

  child = spawn(process.execPath, [mainJs, mode], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("[Samvaad] LiveKit worker spawn error:", err.message);
    child = null;
    scheduleWorkerRestart(null, null);
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (intentionalShutdown) {
      if (signal) {
        console.log(`[Samvaad] LiveKit worker stopped (${signal})`);
      }
      return;
    }

    if (signal) {
      console.warn(`[Samvaad] LiveKit worker exited unexpectedly (${signal})`);
      scheduleWorkerRestart(code, signal);
      return;
    }

    if (code !== 0 && code !== null) {
      console.error(`[Samvaad] LiveKit worker exited with code ${code}`);
      scheduleWorkerRestart(code, null);
      return;
    }

    restartAttempts = 0;
    console.log(`[Samvaad] LiveKit worker exited cleanly (${mode})`);
  });

  console.log(`[Samvaad] LiveKit worker started (${mode})`);
}

function startLiveKitWorker() {
  const embed = shouldEmbedLiveKitWorker();
  if (!embed.embed) {
    console.log(`[Samvaad] LiveKit worker skipped (${embed.reason})`);
    return;
  }

  if (!isConfigured()) {
    console.warn(
      "[Samvaad] LiveKit worker skipped: set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env",
    );
    return;
  }

  intentionalShutdown = false;
  clearRestartTimer();
  restartAttempts = 0;
  spawnWorker();
}

function stopLiveKitWorker() {
  intentionalShutdown = true;
  clearRestartTimer();
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  child = null;
}

function registerWorkerShutdownHooks() {
  const onShutdown = () => {
    stopLiveKitWorker();
    process.exit(0);
  };
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);
}

module.exports = {
  startLiveKitWorker,
  stopLiveKitWorker,
  registerWorkerShutdownHooks,
};
