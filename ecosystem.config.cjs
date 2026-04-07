module.exports = {
  apps: [
    {
      name: "samvaad-api",
      script: "index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Kolkata",
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
