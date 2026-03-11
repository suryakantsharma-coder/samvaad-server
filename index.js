const env = require('./src/config/env');
const connectDB = require('./src/config/db');
const app = require('./src/app');
const { startAgent } = require('./src/agent');
const { startAgentNode } = require('./src/agent-node/start-agent-node.cjs');

const start = async () => {
  await connectDB();
  app.listen(env.PORT, () => {
    console.log(`[Samvaad] Server running on port ${env.PORT} (${env.NODE_ENV})`);
  });

  // Start the WebSocket voice agent (hospital-based media endpoints)
  await startAgent();

  // Start the LiveKit agent-node (Neha voice agent) when server starts
  const enableLiveKit = process.env.ENABLE_LIVEKIT_AGENT !== 'false';
  if (enableLiveKit) {
    startAgentNode().catch((err) => {
      console.error('[Samvaad] LiveKit agent-node failed to start:', err.message);
      console.error('[Samvaad] Set ENABLE_LIVEKIT_AGENT=false to skip.');
    });
  } else {
    console.log('[Samvaad] LiveKit agent-node disabled (ENABLE_LIVEKIT_AGENT=false)');
  }
};

start().catch((err) => {
  console.error('[Samvaad] Failed to start:', err);
  process.exit(1);
});
