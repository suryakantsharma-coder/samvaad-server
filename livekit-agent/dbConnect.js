/**
 * Shared MongoDB connection for the LiveKit worker (same URI as main Samvaad app).
 * Uses the repo-root mongoose singleton so HospitalModel and other models share this connection
 * (a second mongoose in livekit-agent/node_modules caused buffering timeouts).
 */
const path = require("path");
const mongoose = require(path.join(__dirname, "..", "node_modules", "mongoose"));

let connecting = null;

async function ensureMongoConnected() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI;
  if (!uri || !String(uri).trim()) {
    throw new Error("MONGODB_URI is not set in .env (repo root .env)");
  }
  if (connecting) {
    await connecting;
    return;
  }
  connecting = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await connecting;
    console.log("[LiveKit Agent] MongoDB connected:", mongoose.connection.host);
  } finally {
    connecting = null;
  }
}

module.exports = { ensureMongoConnected };
