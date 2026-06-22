module.exports = {
  apps: [
    {
      name: "samvaad-api",
      script: "index.js",
      cwd: __dirname,
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
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        LIVEKIT_NUM_IDLE_PROCESSES: "1",
        LIVEKIT_INIT_PROCESS_TIMEOUT_MS: "45000",
        LIVEKIT_LOAD_THRESHOLD: "0.85",
        SARVAM_STT_STREAMING: "1",
        AGENT_COMPACT_HOSPITAL_PROMPT: "1",
        AGENT_SKIP_POSTCALL_IF_BOOKED: "1",
      },
    },
    {
      name: "samvaad-queue-worker",
      script: "livekit-agent/phoneQueueWorker.js",
      args: "start",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        /** Must match .env LIVEKIT_QUEUE_ENABLED=1 on the server. */
        LIVEKIT_QUEUE_ENABLED: "1",
        QUEUE_NUM_IDLE_PROCESSES: "1",
        LIVEKIT_INIT_PROCESS_TIMEOUT_MS: "45000",
        LIVEKIT_LOAD_THRESHOLD: "0.85",
      },
    },
    {
      name: "samvaad-reminder-worker",
      script: "src/workers/reminderWorkerEntry.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
      },
    },
  ],
};
