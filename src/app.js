const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const routes = require("./routes");
const cors = require("cors");
const {
  generateGoogleAuthUrl,
  exchangeCodeAndStoreTokens,
} = require("./services/googleMeet.service");
const app = express();

// Serve uploaded files (e.g. hospital logos)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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

app.get("/auth/google", (req, res) => {
  const state = req.query.state ? String(req.query.state) : undefined;
  const url = generateGoogleAuthUrl(state);
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = req.query.code ? String(req.query.code) : "";
    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    const tokens = await exchangeCodeAndStoreTokens(code);
    return res.status(200).send(
      `Google connected successfully. Token expiry: ${tokens.expiry_date || "unknown"}`
    );
  } catch (err) {
    return next(err);
  }
});

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
  json10kb(req, res, next);
});
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
