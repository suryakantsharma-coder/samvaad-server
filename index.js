const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const { startAgent } = require('./src/agent');

const start = async () => {
  await connectDB();
  app.listen(env.PORT, () => {
    console.log(`[Samvaad] Server running on port ${env.PORT} (${env.NODE_ENV})`);
  });
  
  // Start the agent server (WebSocket for voice chat)
  // Wait for agent to initialize hospitals before continuing
  await startAgent();
};

start().catch((err) => {
  console.error('[Samvaad] Failed to start:', err);
  process.exit(1);
});
