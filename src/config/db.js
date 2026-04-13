const mongoose = require("mongoose");
const env = require("./env");
const GoogleOAuthToken = require("../models/googleOAuthToken.model");

const connectDB = async () => {
  if (!env.MONGODB_URI || env.MONGODB_URI.trim() === "") {
    console.error(
      "[Samvaad] MONGODB_URI is missing. Add it to your .env file (see .env.example)."
    );
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(env.MONGODB_URI);
    const host = conn.connection.host;
    const isAtlas = host.includes("mongodb.net");
    console.log(
      `[Samvaad] MongoDB connected: ${host} ${isAtlas ? "(Atlas cluster)" : ""}`
    );

    /**
     * Drop stale indexes not declared on the schema (e.g. legacy unique on `provider` alone).
     * The model uses compound unique `{ hospital: 1, provider: 1 }` so each hospital can store tokens.
     */
    try {
      await GoogleOAuthToken.syncIndexes();
      console.log(
        "[Samvaad] GoogleOAuthToken indexes synchronized (compound hospital+provider; stale provider-only unique removed if present)"
      );
    } catch (syncErr) {
      console.warn(
        "[Samvaad] GoogleOAuthToken.syncIndexes failed (OAuth may still fail until indexes are fixed):",
        syncErr.message
      );
    }
  } catch (err) {
    console.error("[Samvaad] MongoDB connection error:", err.message);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.log("[Samvaad] MongoDB disconnected");
});

module.exports = connectDB;
