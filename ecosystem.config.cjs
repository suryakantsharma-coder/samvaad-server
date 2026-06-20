module.exports = {
  apps: [
    {
      name: "samvaad-api",
      script: "index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
        /** Voice worker runs in samvaad-livekit-worker — keeps API CPU free for concurrent calls. */
        LIVEKIT_WORKER_DISABLED: "1",
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
        LIVEKIT_NUM_IDLE_PROCESSES: "2",
        LIVEKIT_INIT_PROCESS_TIMEOUT_MS: "20000",
        SARVAM_STT_STREAMING: "1",
        AGENT_COMPACT_HOSPITAL_PROMPT: "1",
        AGENT_SKIP_POSTCALL_IF_BOOKED: "1",
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
