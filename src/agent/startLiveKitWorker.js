const path = require("path");
const { spawn } = require("child_process");

let child = null;
let shutdownRegistered = false;

function registerParentShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const stop = () => {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch (e) {}
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("beforeExit", stop);
}

/**
 * Spawn the LiveKit voice worker alongside the main API (npm run dev / npm start).
 * Set DISABLE_LIVEKIT_WORKER=1 to skip. Requires LiveKit + OpenAI env vars when enabled.
 */
function startLiveKitWorker() {
  if (
    process.env.DISABLE_LIVEKIT_WORKER === "1" ||
    process.env.DISABLE_LIVEKIT_WORKER === "true"
  ) {
    console.log("[Samvaad] LiveKit worker not started (DISABLE_LIVEKIT_WORKER)");
    return;
  }

  const need = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "OPENAI_API_KEY"];
  const missing = need.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length) {
    console.log(
      `[Samvaad] LiveKit worker not started (missing env: ${missing.join(", ")}). ` +
        "Set them in .env or use DISABLE_LIVEKIT_WORKER=1.",
    );
    return;
  }

  const projectRoot = path.resolve(__dirname, "..", "..");
  const mainJs = path.join(projectRoot, "livekit-agent", "main.js");
  const mode = process.env.NODE_ENV === "production" ? "start" : "dev";

  child = spawn(process.execPath, [mainJs, mode], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("[Samvaad] LiveKit worker spawn error:", err.message);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[Samvaad] LiveKit worker stopped (signal ${signal})`);
    } else if (code !== 0 && code !== null) {
      console.warn(`[Samvaad] LiveKit worker exited with code ${code}`);
    }
    child = null;
  });

  registerParentShutdown();
  console.log(
    `[Samvaad] LiveKit worker started (${mode}) — agent: ${process.env.AGENT_NAME || "phone-agent"}`,
  );
}

module.exports = { startLiveKitWorker };
