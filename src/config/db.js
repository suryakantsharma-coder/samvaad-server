const mongoose = require("mongoose");
const env = require("./env");

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
  } catch (err) {
    console.error("[Samvaad] MongoDB connection error:", err.message);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.log("[Samvaad] MongoDB disconnected");
});

module.exports = connectDB;
