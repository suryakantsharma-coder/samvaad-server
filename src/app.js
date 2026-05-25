const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const routes = require("./routes");
const cors = require("cors");
const { exchangeCodeAndStoreTokensForHospital } = require("./services/googleMeet.service");
const env = require("./config/env");
const authController = require("./controllers/authController");
const app = express();

const uploadCorsAllowedOrigins = env.UPLOADS_CORS_ORIGINS || [];

const setUploadCorsHeaders = (req, res) => {
  const origin = req.headers.origin;
  if (origin && uploadCorsAllowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");
};

// Public static uploads CORS (for PDF logo/image fetch from browser)
app.use("/uploads", (req, res, next) => {
  setUploadCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Serve uploaded files (e.g. hospital logos) — same root as multer (see env.UPLOADS_ROOT)
app.use(
  "/uploads",
  express.static(env.UPLOADS_ROOT, {
    setHeaders: (res, _filePath, stat) => {
      // Ensure exposed headers are present on static 200 responses.
      if (stat) {
        res.setHeader("Content-Length", String(stat.size));
      }
      if (!res.getHeader("Access-Control-Allow-Methods")) {
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      }
      if (!res.getHeader("Access-Control-Allow-Headers")) {
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      }
      if (!res.getHeader("Access-Control-Expose-Headers")) {
        res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");
      }
    },
  }),
);

// allowed origins
const allowedOrigins = [
  // "https://samvaad-psi.vercel.app",
  "http://localhost:5173",
];

// allow all origins
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// cors policy
// app.use(
//   cors({
//     origin: function (origin, callback) {
//       if (!origin || allowedOrigins.includes(origin)) {
//         callback(null, true);
//       } else {
//         callback(new Error("Not allowed by CORS"));
//       }
//     },
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   }),
// );

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Meta WhatsApp / Razorpay webhooks can burst; do not throttle verification or event delivery.
  skip: (req) =>
    req.originalUrl.includes("/whatsapp/webhook") ||
    req.originalUrl.includes("/api/razorpay/webhook"),
});

// WhatsApp webhook: larger body limit + raw buffer for X-Hub-Signature-256 (must run before global json).
const whatsappWebhookJson = express.json({
  limit: "512kb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});

app.use("/api/whatsapp/webhook", (req, res, next) => {
  if (req.method === "POST") {
    return whatsappWebhookJson(req, res, next);
  }
  next();
});

// Razorpay webhook: raw body buffer for X-Razorpay-Signature verification (must run before global json).
const razorpayWebhookJson = express.json({
  limit: "512kb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});

app.use("/api/razorpay/webhook", (req, res, next) => {
  if (req.method === "POST") {
    return razorpayWebhookJson(req, res, next);
  }
  next();
});

// Root /whatsapp/webhook (Meta callback without /api) — larger JSON body before global 10kb limit
const rootWhatsappWebhookJson = express.json({ limit: "512kb" });
app.use("/whatsapp/webhook", (req, res, next) => {
  if (req.method === "POST") {
    return rootWhatsappWebhookJson(req, res, next);
  }
  next();
});

const whatsappRootWebhook = require("./routes/whatsappRootWebhook");
app.use(whatsappRootWebhook);

/**
 * Google OAuth callback (must match GOOGLE_REDIRECT_URI). State binds hospital; tokens stored per hospital.
 */
app.get("/auth/google/callback", async (req, res) => {
  const frontendBase =
    env.FRONTEND_GOOGLE_OAUTH_RETURN_URL || "http://localhost:5173";
  const redirectError = (reason) =>
    res.redirect(
      `${frontendBase}?google=error&reason=${encodeURIComponent(reason)}`,
    );

  try {
    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) {
      return redirectError("missing_code_or_state");
    }

    await exchangeCodeAndStoreTokensForHospital(code, state);
    return res.redirect(`${frontendBase}?google=success`);
  } catch (err) {
    console.error("[Google OAuth callback]", err.message);
    return redirectError(err.message || "oauth_failed");
  }
});

/** Public HTML page for password reset (no login or role required). */
app.get("/auth/reset-password", authController.renderResetPasswordPage);

const json10kb = express.json({ limit: "10kb" });
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/api/whatsapp/webhook") {
    return next();
  }
  if (req.method === "POST" && req.path === "/api/razorpay/webhook") {
    return next();
  }
  if (req.method === "POST" && req.path === "/whatsapp/webhook") {
    return next();
  }
  // Do not run express.json on multipart — it can interfere with multer reading the stream.
  const ct = req.headers["content-type"] || "";
  if (ct.toLowerCase().includes("multipart/form-data")) {
    return next();
  }
  json10kb(req, res, next);
});
app.use(cookieParser());
app.use("/api", apiLimiter, routes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("[Samvaad] Error:", err.message);
  if (err.stack) console.error(err.stack);

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
