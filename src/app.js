const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const routes = require("./routes");
const cors = require("cors");
const app = express();

// Serve uploaded files (e.g. hospital logos)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// cors policy
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use("/api", apiLimiter, routes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("[Samvaad] Error:", err.message);

  let status = err.statusCode || 500;
  let message = err.message || "Internal server error";

  if (err.name === "CastError") {
    status = 400;
    message = "Invalid resource id";
  }
  if (err.name === "ValidationError") {
    status = 400;
    message =
      Object.values(err.errors || {})
        .map((e) => e.message)
        .join("; ") || message;
  }
  if (err.code === 11000) {
    status = 409;
    message = "Resource already exists with this unique field";
  }

  res.status(status).json({
    success: false,
    message,
  });
});

module.exports = app;
