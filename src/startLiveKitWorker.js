const { spawn } = require("child_process");
const path = require("path");

let child = null;

function isConfigured() {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

function startLiveKitWorker() {
  if (
    process.env.LIVEKIT_WORKER_DISABLED === "1" ||
    process.env.LIVEKIT_WORKER_DISABLED === "true"
  ) {
    console.log(
      "[Samvaad] LiveKit worker skipped (LIVEKIT_WORKER_DISABLED)",
    );
    return;
  }

  if (!isConfigured()) {
    console.warn(
      "[Samvaad] LiveKit worker skipped: set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env",
    );
    return;
  }

  const mode = process.env.NODE_ENV === "production" ? "start" : "dev";
  const mainJs = path.join(__dirname, "..", "livekit-agent", "main.js");

  child = spawn(process.execPath, [mainJs, mode], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("[Samvaad] LiveKit worker spawn error:", err.message);
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (signal) {
      console.log(`[Samvaad] LiveKit worker stopped (${signal})`);
    } else if (code !== 0 && code !== null) {
      console.error(`[Samvaad] LiveKit worker exited with code ${code}`);
    }
  });

  console.log(`[Samvaad] LiveKit worker started (${mode})`);
}

function stopLiveKitWorker() {
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
