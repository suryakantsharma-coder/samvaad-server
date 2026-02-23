const path = require("path");

// Load .env from project root (same folder as index.js / package.json)
// so MONGODB_URI is read correctly no matter where you run the app from
require("dotenv").config({
  path: path.resolve(__dirname, "..", "..", ".env"),
});

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_ACCESS_SECRET:
    process.env.JWT_ACCESS_SECRET ||
    "samvaad-access-secret-change-in-production",
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET ||
    "samvaad-refresh-secret-change-in-production",
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || "15m",
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY || "7d",
  COOKIE_REFRESH_MAX_AGE: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  CLOUDFLARE_DOMAIN: process.env.CLOUDFLARE_DOMAIN || null, // e.g., "your-domain.com" or "agent.your-domain.com"
  AGENT_PORT: parseInt(process.env.AGENT_PORT, 10) || 5002,
};

module.exports = env;
