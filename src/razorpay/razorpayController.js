const crypto = require("crypto");
const env = require("../config/env");
const { upsertFromRazorpayWebhook } = require("../services/paymentHistory.service");
const { tryBookVideoCallOnPaymentCaptured } = require("../services/razorpayAppointmentBooking.service");
const { notifyAppointmentBooked } = require("../services/appointmentWhatsAppNotify");
const { getRazorpayInstance } = require("./client");
const { verifyRazorpayWebhookSignature } = require("./verifyWebhookSignature");

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fields worth persisting / reconciling (no PII). Used for a single webhook log line after signature OK.
 */
/** Verbose webhook logs: full trace + payload. Off only when RAZORPAY_WEBHOOK_VERBOSE=0 or NODE_ENV=test. */
function shouldLogRazorpayWebhookVerbose() {
  if (process.env.NODE_ENV === "test") return false;
  const v = String(env.RAZORPAY_WEBHOOK_VERBOSE || "").toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}

function isWebhookDebugEnabled() {
  const v = String(env.RAZORPAY_WEBHOOK_DEBUG || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function pickPersistableWebhookFields(body) {
  const event = body?.event;
  const row = { event: event || "unknown" };

  const pay = body?.payload?.payment?.entity;
  if (pay && typeof pay === "object") {
    if (pay.id != null) row.paymentId = pay.id;
    if (pay.order_id != null) row.orderId = pay.order_id;
    if (pay.amount != null) row.amount = pay.amount;
    if (pay.currency != null) row.currency = pay.currency;
    if (pay.status != null) row.status = pay.status;
    if (pay.captured != null) row.captured = pay.captured;
    if (pay.method != null) row.method = pay.method;
    if (pay.fee != null) row.fee = pay.fee;
    if (pay.tax != null) row.tax = pay.tax;
    if (pay.amount_refunded != null) row.amountRefunded = pay.amount_refunded;
    if (pay.error_code != null) row.errorCode = pay.error_code;
  }

  const ord = body?.payload?.order?.entity;
  if (ord && typeof ord === "object") {
    if (row.orderId == null && ord.id != null) row.orderId = ord.id;
    if (ord.receipt != null) row.orderReceipt = ord.receipt;
    if (ord.status != null) row.orderStatus = ord.status;
    if (row.amount == null && ord.amount != null) row.amount = ord.amount;
    if (row.currency == null && ord.currency != null)
      row.currency = ord.currency;
  }

  const refund = body?.payload?.refund?.entity;
  if (refund && typeof refund === "object") {
    if (refund.id != null) row.refundId = refund.id;
    if (refund.payment_id != null) row.refundPaymentId = refund.payment_id;
    if (refund.amount != null) row.refundAmount = refund.amount;
    if (refund.currency != null) row.refundCurrency = refund.currency;
    if (refund.status != null) row.refundStatus = refund.status;
  }

  return row;
}

/**
 * POST /api/razorpay/create-order
 * Body: { amount (paise), currency?, receipt?, notes? }
 *
 * Optional **notes** (strings only): for tele-caller booking on **`payment.captured`** — `bookVideoAppointment`, `patient`, `doctor`, `reason`, `appointmentDateTime`, `patientEmail`, `doctorEmail` (Meet link is created server-side; do not rely on `videoUrl` in notes).
 */
const createOrder = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV !== "test") {
      console.log("[Razorpay create-order] POST", {
        amount: req.body?.amount,
        currency: req.body?.currency,
        receipt: req.body?.receipt,
        hasNotes: Boolean(
          req.body?.notes &&
            typeof req.body.notes === "object" &&
            !Array.isArray(req.body.notes)
        ),
        notes: req.body?.notes,
      });
    }

    const razorpay = getRazorpayInstance();
    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message:
          "Razorpay is not configured (set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)",
      });
    }

    const amount = parseInt(req.body.amount, 10);

    const currency =
      (req.body.currency && String(req.body.currency).trim()) || "INR";
    const receipt =
      (req.body.receipt && String(req.body.receipt).trim()) ||
      `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const options = {
      amount,
      currency,
      receipt,
    };

    if (
      req.body.notes &&
      typeof req.body.notes === "object" &&
      !Array.isArray(req.body.notes)
    ) {
      options.notes = req.body.notes;
    }

    const order = await razorpay.orders.create(options);
    if (process.env.NODE_ENV !== "test") {
      console.log("[Razorpay create-order] Razorpay order created:", order.id);
    }
    res.json({ success: true, ...order });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/razorpay/verify-payment
 * Verifies the Razorpay payment signature (`order_id|payment_id` HMAC). Does not create appointments.
 *
 * Body: `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` (required).
 * Response: `{ success: true }` on valid signature, `400` on invalid.
 */
const verifyPayment = async (req, res, next) => {
  try {
    const bodyIn = req.body || {};
    if (process.env.NODE_ENV !== "test") {
      const logBody = { ...bodyIn };
      if (logBody.razorpay_signature != null) {
        const s = String(logBody.razorpay_signature);
        logBody.razorpay_signature = s.length
          ? `[redacted, ${s.length} hex chars]`
          : logBody.razorpay_signature;
      }
      console.log("[Razorpay verify-payment] body:", logBody);
    }

    const secret = env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(503).json({
        success: false,
        message: "RAZORPAY_KEY_SECRET is not configured",
      });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      bodyIn;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message:
          "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required",
      });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    const ok = timingSafeEqualHex(expectedSignature, razorpay_signature);
    if (process.env.NODE_ENV !== "test") {
      console.log(
        "[Razorpay verify-payment] result:",
        ok ? "signature OK" : "INVALID_SIGNATURE"
      );
    }

    if (!ok) {
      return res.status(400).json({ success: false });
    }

    return res.json({ success: true });
  } catch (err) {
    if (err.statusCode) {
      return res
        .status(err.statusCode)
        .json({ success: false, message: err.message });
    }
    next(err);
  }
};

/**
 * GET /api/razorpay/webhook-info
 * Explains why Test/Live webhooks do not hit localhost (browser success ≠ server webhook).
 */
const webhookInfo = (req, res) => {
  const host = req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const webhookPostUrl = `${proto}://${host}/api/razorpay/webhook`;

  const keySecret = env.RAZORPAY_KEY_SECRET;
  const whSecret = env.RAZORPAY_WEBHOOK_SECRET;
  const webhookSecretConfigured = Boolean(whSecret && String(whSecret).trim().length);
  const webhookSecretSameAsKeySecret =
    Boolean(keySecret && whSecret && String(keySecret).trim() === String(whSecret).trim());

  res.json({
    success: true,
    webhookPostUrl,
    envCheck: {
      webhookSecretConfigured,
      webhookSecretSameAsKeySecret,
      ...(webhookSecretSameAsKeySecret || !webhookSecretConfigured
        ? {
            warning:
              webhookSecretSameAsKeySecret
                ? "RAZORPAY_WEBHOOK_SECRET must NOT be the same as RAZORPAY_KEY_SECRET. Use the signing secret from Dashboard → Webhooks only."
                : "Set RAZORPAY_WEBHOOK_SECRET to the Webhooks signing secret (Dashboard → Webhooks → your URL).",
          }
        : {}),
    },
    message:
      "Razorpay sends webhooks from its servers to this POST URL. It cannot reach http://localhost — use a public HTTPS URL (e.g. trycloudflare) and register it in Dashboard → Webhooks.",
    testModeWebhooks: {
      summary:
        "Test-mode webhooks only fire for payments created with Test API keys. The Dashboard must be in Test mode when you add the webhook and copy the secret.",
      checklist: [
        "Frontend / Checkout must use Key ID starting with rzp_test_. Live keys never trigger Test webhooks.",
        "In Razorpay Dashboard, switch to Test mode, then Account & Settings → Webhooks → add your URL. If asked for OTP in test mode, use 754081 (Razorpay default per docs).",
        "Subscribe to payment.captured and payment.failed (required for PaymentHistory). Optionally payment.authorized.",
        "Put the Test webhook secret into RAZORPAY_WEBHOOK_SECRET (different from Live).",
        "Domains like ngrok.io and webhook.site are blacklisted; trycloudflare.com is not in Razorpay’s published blocklist.",
        "If your endpoint returns non-2xx, Razorpay may stop retrying or disable the webhook — check Webhook logs in the Dashboard.",
      ],
      docs: "https://razorpay.com/docs/webhooks/validate-test/",
    },
    debugHint:
      "Verbose webhook logging is on by default (except NODE_ENV=test). Set RAZORPAY_WEBHOOK_VERBOSE=0 to silence. RAZORPAY_WEBHOOK_DEBUG=1 adds the same delivery-attempt line even if you later turn verbose off.",
  });
};

/**
 * POST /api/razorpay/webhook
 * Requires `req.rawBody` (Buffer) from express.json verify hook + X-Razorpay-Signature header.
 * Persists `payment.captured` and `payment.failed` to PaymentHistory.
 */
const webhook = async (req, res) => {
  const verbose = shouldLogRazorpayWebhookVerbose();
  const signature = req.headers["x-razorpay-signature"];
  const raw = req.rawBody;

  if (verbose || isWebhookDebugEnabled()) {
    console.log("[Razorpay webhook] ========== POST received ==========");
    console.log("[Razorpay webhook] time:", new Date().toISOString());
    console.log("[Razorpay webhook] delivery:", {
      rawBodyBytes: Buffer.isBuffer(raw) ? raw.length : 0,
      hasRawBodyBuffer: Buffer.isBuffer(raw),
      hasRazorpaySignatureHeader: Boolean(signature),
      eventId: req.headers["x-razorpay-event-id"] || null,
    });
  }

  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    if (verbose) {
      console.warn(
        "[Razorpay webhook] FAIL: RAZORPAY_WEBHOOK_SECRET is not set in environment",
      );
    }
    return res.status(503).json({
      success: false,
      message: "RAZORPAY_WEBHOOK_SECRET is not configured",
    });
  }

  if (!raw || !Buffer.isBuffer(raw)) {
    if (verbose) {
      console.warn(
        "[Razorpay webhook] FAIL: missing rawBody — check app.js json verify for /api/razorpay/webhook",
      );
    }
    return res.status(400).json({
      success: false,
      message: "Missing raw body for signature verification",
    });
  }

  const signatureOk = verifyRazorpayWebhookSignature(
    raw,
    signature,
    webhookSecret,
  );
  if (!signatureOk) {
    if (verbose) {
      console.warn(
        "[Razorpay webhook] FAIL: signature verification failed (wrong RAZORPAY_WEBHOOK_SECRET or body altered?)",
      );
    }
    return res
      .status(400)
      .json({ success: false, message: "Invalid webhook signature" });
  }

  const payload = req.body;
  const event = payload && payload.event;

  if (verbose) {
    console.log("[Razorpay webhook] OK: signature verified");
    console.log("[Razorpay webhook] event:", event);
    const toSave = pickPersistableWebhookFields(payload);
    console.log(
      "[Razorpay webhook] persistable fields:",
      JSON.stringify(toSave),
    );
    try {
      console.log(
        "[Razorpay webhook] full payload JSON:\n",
        JSON.stringify(payload, null, 2),
      );
    } catch (e) {
      console.log(
        "[Razorpay webhook] full payload (stringify failed):",
        e.message,
      );
    }
    console.log("[Razorpay webhook] ========== end ==========");
  }

  let storedPaymentHistory = null;
  if (event === "payment.captured" || event === "payment.failed") {
    try {
      storedPaymentHistory = await upsertFromRazorpayWebhook(event, payload);
      if (verbose && storedPaymentHistory) {
        console.log(
          "[Razorpay webhook] PaymentHistory stored:",
          storedPaymentHistory.payment_id,
          storedPaymentHistory.status
        );
      }
    } catch (err) {
      console.error("[Razorpay webhook] PaymentHistory save failed:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to save payment history",
      });
    }
  }

  if (event === "payment.captured") {
    try {
      const populated = await tryBookVideoCallOnPaymentCaptured(
        payload,
        storedPaymentHistory
      );
      if (populated) {
        notifyAppointmentBooked(populated).catch((err) =>
          console.error(
            "[Razorpay webhook] WhatsApp notify:",
            err.message,
            err.details || ""
          )
        );
        if (verbose) {
          console.log(
            "[Razorpay webhook] Video appointment booked:",
            populated.appointmentId || populated._id
          );
        }
      }
    } catch (err) {
      console.error("[Razorpay webhook] Video booking error:", err.message);
    }
  }

  res.status(200).json({ success: true, received: true, event: event || null });
};

module.exports = {
  createOrder,
  verifyPayment,
  webhook,
  webhookInfo,
};
