const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const {
  startLiveKitWorker,
  registerWorkerShutdownHooks,
} = require('./src/startLiveKitWorker');

registerWorkerShutdownHooks();

const start = async () => {
  await connectDB();
  app.listen(env.PORT, () => {
    console.log(`[Samvaad] Server running on port ${env.PORT} (${env.NODE_ENV})`);
    startLiveKitWorker();
  });
};

start().catch((err) => {
  console.error('[Samvaad] Failed to start:', err);
  process.exit(1);
});
