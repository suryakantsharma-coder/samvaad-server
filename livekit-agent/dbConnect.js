/**
 * MongoDB for the LiveKit worker (same URI as main app, same root node_modules mongoose).
 */
const mongoose = require("mongoose");

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
