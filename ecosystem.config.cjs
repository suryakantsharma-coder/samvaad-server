/** Shared PM2 options for voice worker processes (heavy Silero VAD preload). */
const voiceWorkerPm2 = {
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  max_restarts: 20,
  min_uptime: "30s",
  restart_delay: 5000,
  kill_timeout: 15000,
};

module.exports = {
  apps: [
    {
      name: "samvaad-api",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        /** Voice workers run in dedicated PM2 apps — never embed in API in production. */
        LIVEKIT_WORKER_DISABLED: "1",
        QUEUE_WORKER_DISABLED: "1",
        REMINDER_WORKER_DISABLED: "1",
      },
    },
    {
      name: "samvaad-livekit-worker",
      script: "livekit-agent/main.js",
      args: "start",
      cwd: __dirname,
      ...voiceWorkerPm2,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        LIVEKIT_NUM_IDLE_PROCESSES: "1",
        LIVEKIT_INIT_PROCESS_TIMEOUT_MS: "45000",
        LIVEKIT_LOAD_THRESHOLD: "0.85",
        // Batch REST STT (streaming WS endpoint rejects saaras:v3). Set "1" only
        // after configuring a streaming model your Sarvam account supports.
        SARVAM_STT_STREAMING: "0",
        AGENT_COMPACT_HOSPITAL_PROMPT: "1",
        AGENT_SKIP_POSTCALL_IF_BOOKED: "1",
        // Quiet the LiveKit framework's info-level pino logs in production.
        // Use "info" or "debug" locally to see everything.
        LOG_LEVEL: "warn",
      },
    },
    {
      name: "samvaad-queue-worker",
      script: "livekit-agent/phoneQueueWorker.js",
      args: "start",
      cwd: __dirname,
      ...voiceWorkerPm2,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        /** Must match .env LIVEKIT_QUEUE_ENABLED=1 on the server. */
        LIVEKIT_QUEUE_ENABLED: "1",
        QUEUE_NUM_IDLE_PROCESSES: "1",
        LIVEKIT_INIT_PROCESS_TIMEOUT_MS: "45000",
        LIVEKIT_LOAD_THRESHOLD: "0.85",
        LOG_LEVEL: "warn",
      },
    },
    {
      name: "samvaad-reminder-worker",
      script: "src/workers/reminderWorkerEntry.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
      },
    },
  ],
};
