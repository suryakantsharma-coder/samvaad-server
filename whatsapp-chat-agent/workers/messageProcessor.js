const mongoose = require("mongoose");
const env = require("../../src/config/env");
const WhatsApp = require("../../src/models/whatsapp.model");
const Hospital = require("../../src/models/hospital.model");
const {
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
} = require("../../src/services/whatsappCloud");
const {
  isWhatsApiConfigured,
  sendWhatsApiText,
} = require("../services/whatsapiService");
const { isEnglishMessage } = require("../utils/languageDetector");
const { INTENTS, detectIntent } = require("../utils/intentDetector");
const {
  getContext,
  setHospitalId,
  appendMessage,
  resetFlows,
} = require("../services/contextService");
const { answerGeneralQuestion } = require("../services/aiService");
const {
  handleAppointmentMessage,
  startAppointmentFlow,
} = require("../flows/appointmentFlow");
const {
  startPrescriptionFlow,
  handlePrescriptionMessage,
  wantsFullDetailsOrLinks,
} = require("../flows/prescriptionFlow");

const NON_ENGLISH_REPLY =
  "Thank you for your message. To serve you accurately, please continue in *English*.";

const SERIOUS_RE =
  /chest\s+pain|breathing\s+problem|difficulty\s+breathing|can't\s+breathe|cannot\s+breathe|trouble\s+breathing|heavy\s+bleeding|severe\s+bleeding|\bemergency\b|heart\s+attack|unconscious|stroke/i;

function formatHospitalPhoneFromDoc(h) {
  if (!h) return null;
  const cc = String(h.phoneCountryCode || "").trim();
  const num = String(h.phoneNumber || "").trim();
  return cc && num ? `${cc} ${num}`.replace(/\s+/g, " ").trim() : num || null;
}

function buildEmergencyReply(hospital) {
  const name = hospital?.name?.trim() || "our hospital";
  const phone = formatHospitalPhoneFromDoc(hospital);
  const lines = [
    "*Important — your wellbeing comes first*",
    "",
    "If you believe this may be life-threatening, please call your local emergency number *immediately*.",
    "",
  ];
  if (phone) {
    lines.push(
      `You may also contact *${name}* on ${phone}, or attend the emergency department at *${name}* without delay.`
    );
  } else {
    lines.push(
      `Please contact *${name}* urgently, or go directly to the emergency department.`
    );
  }
  return lines.join("\n");
}

/** User message suggests they need care / where to go — show booking CTA + optional buttons */
function userSeemsToNeedCareGuidance(text) {
  return /\b(feel|feeling|unwell|sick|ill|poorly|pain|hurts?|hurt|ache|symptom|where\s+(do\s+i\s+)?(go|should)|not\s+feeling|need\s+(a\s+)?doctor|see\s+(a\s+)?doctor|fever|nausea|vomit|dizzy|weak|cough|cold|flu|worse|uncomfortable|something\s+wrong|health\s+problem)\b/i.test(
    String(text || "")
  );
}

const CANCEL_RE = /^\s*(cancel|stop|exit|reset)\s*$/i;

function extractUserTextFromMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const t = msg.type;
  if (t === "text" && msg.text?.body != null) {
    return String(msg.text.body);
  }
  if (t === "button" && msg.button?.text != null) {
    return String(msg.button.text);
  }
  if (t === "interactive" && msg.interactive) {
    const i = msg.interactive;
    if (i.type === "button_reply" && i.button_reply?.title != null) {
      return String(i.button_reply.title);
    }
    if (i.type === "list_reply" && i.list_reply?.title != null) {
      return String(i.list_reply.title);
    }
  }
  return null;
}

function extractInboundPayloads(body) {
  /** @type {{ from: string, body: string, phoneNumberId: string }[]} */
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value =
        change.value && typeof change.value === "object" ? change.value : {};
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const msg of messages) {
        const bodyText = extractUserTextFromMessage(msg);
        if (bodyText == null || !String(bodyText).trim()) continue;
        out.push({
          from: String(msg.from || ""),
          body: String(bodyText),
          phoneNumberId: String(phoneNumberId || ""),
        });
      }
    }
  }
  return out;
}

function hospitalDigits(hospital) {
  return (hospital?.phoneCountryCode || "+91").replace(/\D/g, "") || "91";
}

/**
 * Load hospital + send credentials. Meta access_token is optional when outbound uses WhatsAPI only.
 */
async function loadOutboundFromMongo(phoneNumberId) {
  const pid = String(phoneNumberId || "").trim();
  if (!pid) return null;

  const creds = await WhatsApp.findOne({ phone_number_id: pid })
    .sort({ updatedAt: -1 })
    .lean();

  if (!creds?.hospitalId) return null;

  const hospital = await Hospital.findById(creds.hospitalId)
    .select("phoneCountryCode")
    .lean();

  const outbound = {
    phoneNumberId: creds.phone_number_id || pid,
    accessToken: (creds.access_token || "").trim(),
    apiVersion: creds.api_version,
    hospitalId: String(creds.hospitalId),
    defaultCountryDigits: hospitalDigits(hospital),
  };

  const needMetaToken = !isWhatsApiConfigured();
  if (needMetaToken && !outbound.accessToken) {
    console.warn(
      "[whatsapp-chat-agent] WhatsApp Mongo row has no access_token; set token or configure WhatsAPI (WHATSAPI_*)."
    );
    return null;
  }

  return outbound;
}

/**
 * Meta Cloud token from env when DB has no row (single-tenant / dev).
 */
async function loadOutboundFromEnvMeta(phoneNumberId) {
  const token = env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const envPid = env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  const webhookPid = String(phoneNumberId || "").trim();
  const hid = env.WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID;

  if (!token || !webhookPid || !hid || !mongoose.Types.ObjectId.isValid(hid)) {
    return null;
  }
  if (isWhatsApiConfigured()) return null;
  if (envPid && String(envPid) !== webhookPid) {
    console.warn(
      "[whatsapp-chat-agent] Webhook phone_number_id does not match WHATSAPP_CLOUD_PHONE_NUMBER_ID"
    );
    return null;
  }

  const hospital = await Hospital.findById(hid).select("phoneCountryCode").lean();
  return {
    phoneNumberId: webhookPid,
    accessToken: token,
    apiVersion: env.WHATSAPP_CLOUD_API_VERSION,
    hospitalId: String(hid),
    defaultCountryDigits: hospitalDigits(hospital),
  };
}

async function loadOutboundFromWhatsApiDefaultHospital() {
  const hid = env.WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID;
  if (!isWhatsApiConfigured() || !hid || !mongoose.Types.ObjectId.isValid(hid)) {
    return null;
  }
  const hospital = await Hospital.findById(hid).select("phoneCountryCode").lean();
  return {
    phoneNumberId: "",
    accessToken: "",
    apiVersion: undefined,
    hospitalId: String(hid),
    defaultCountryDigits: hospitalDigits(hospital),
  };
}

/**
 * Resolve hospital for DB + how to send: Mongo WhatsApp row, env Meta token, or WhatsAPI + default hospital.
 */
async function resolveOutboundForChat(phoneNumberId) {
  if (phoneNumberId) {
    const fromMongo = await loadOutboundFromMongo(phoneNumberId);
    if (fromMongo) return fromMongo;

    const fromEnv = await loadOutboundFromEnvMeta(phoneNumberId);
    if (fromEnv) return fromEnv;
  }

  return loadOutboundFromWhatsApiDefaultHospital();
}

async function sendReply(outbound, to, text, options = {}) {
  const { interactiveBody, interactiveButtons } = options;

  const canUseInteractive =
    Array.isArray(interactiveButtons) &&
    interactiveButtons.length > 0 &&
    outbound.phoneNumberId &&
    outbound.accessToken &&
    !isWhatsApiConfigured();

  if (canUseInteractive) {
    const body = String(interactiveBody || text || "").trim().slice(0, 1024);
    if (body) {
      try {
        await sendWhatsAppInteractiveButtons({
          phoneNumberId: outbound.phoneNumberId,
          accessToken: outbound.accessToken,
          to,
          bodyText: body,
          buttons: interactiveButtons,
          defaultCountryDigits: outbound.defaultCountryDigits,
          apiVersion: outbound.apiVersion || undefined,
        });
        return;
      } catch (err) {
        console.error(
          "[whatsapp-chat-agent] interactive send failed, falling back to text:",
          err.message,
          err.details || err.status || ""
        );
      }
    }
  }

  const chunk = String(text || "").slice(0, 3500);
  if (!chunk) return;

  if (isWhatsApiConfigured()) {
    try {
      await sendWhatsApiText({
        to,
        textBody: chunk,
        defaultCountryDigits: outbound.defaultCountryDigits,
      });
      return;
    } catch (err) {
      console.error(
        "[whatsapp-chat-agent] WhatsAPI send failed:",
        err.message,
        err.details || err.status || ""
      );
      if (outbound.accessToken && outbound.phoneNumberId) {
        console.warn("[whatsapp-chat-agent] Retrying send via Meta Cloud API");
        await sendWhatsAppText({
          phoneNumberId: outbound.phoneNumberId,
          accessToken: outbound.accessToken,
          to,
          textBody: chunk,
          defaultCountryDigits: outbound.defaultCountryDigits,
          apiVersion: outbound.apiVersion || undefined,
        });
        return;
      }
      throw err;
    }
  }

  await sendWhatsAppText({
    phoneNumberId: outbound.phoneNumberId,
    accessToken: outbound.accessToken,
    to,
    textBody: chunk,
    defaultCountryDigits: outbound.defaultCountryDigits,
    apiVersion: outbound.apiVersion || undefined,
  });
}

async function routeOneMessage({ from, body, phoneNumberId }) {
  if (mongoose.connection.readyState !== 1) {
    console.warn("[whatsapp-chat-agent] MongoDB not connected; skip inbound message");
    return;
  }

  if (!from) {
    console.warn("[whatsapp-chat-agent] Missing sender phone");
    return;
  }

  if (!phoneNumberId && !isWhatsApiConfigured()) {
    console.warn("[whatsapp-chat-agent] Missing phone_number_id (and WhatsAPI not configured)");
    return;
  }

  const outbound = await resolveOutboundForChat(phoneNumberId);
  if (!outbound) {
    console.warn(
      "[whatsapp-chat-agent] No outbound context: link Meta WhatsApp creds to this phone_number_id or set WHATSAPP_CHAT_DEFAULT_HOSPITAL_ID with WhatsAPI"
    );
    return;
  }

  const hospitalDoc = await Hospital.findById(outbound.hospitalId)
    .select("name phoneCountryCode phoneNumber")
    .lean();

  const userText = String(body || "").trim();
  const ctx = getContext(from);
  if (!ctx) return;

  setHospitalId(from, outbound.hospitalId);
  ctx.hospitalId = outbound.hospitalId;

  if (CANCEL_RE.test(userText)) {
    resetFlows(from);
    await sendReply(
      outbound,
      from,
      "Your current request has been cancelled.\n\nHow may we assist you today?"
    );
    return;
  }

  if (SERIOUS_RE.test(userText)) {
    await sendReply(outbound, from, buildEmergencyReply(hospitalDoc));
    return;
  }

  if (!isEnglishMessage(userText)) {
    await sendReply(outbound, from, NON_ENGLISH_REPLY);
    return;
  }

  appendMessage(from, "user", userText);

  let result;
  try {
    if (ctx.activeFlow === "appointment") {
      result = await handleAppointmentMessage(
        ctx,
        userText,
        from,
        outbound.hospitalId
      );
    } else if (ctx.activeFlow === "prescription") {
      result = await handlePrescriptionMessage(
        ctx,
        userText,
        from,
        outbound.hospitalId
      );
    } else {
      const intent = detectIntent(userText);
      const recentTranscript = [...(ctx.messages || []).slice(-8).map((m) => m.text), userText].join(
        " "
      );
      if (
        wantsFullDetailsOrLinks(userText) &&
        /\bprescription|prescriptions|medicine|medications|rx\b|P-\d{4}-\d+/i.test(
          recentTranscript
        )
      ) {
        result = await startPrescriptionFlow(ctx, from, outbound.hospitalId);
      } else if (intent === INTENTS.BOOK_APPOINTMENT) {
        const start = startAppointmentFlow(ctx);
        if (!userText.match(/new|existing/i)) {
          result = start;
        } else {
          result = await handleAppointmentMessage(
            ctx,
            userText,
            from,
            outbound.hospitalId
          );
        }
      } else if (intent === INTENTS.GET_PRESCRIPTION) {
        result = await startPrescriptionFlow(ctx, from, outbound.hospitalId);
      } else {
        const recent = (ctx.messages || [])
          .slice(-8)
          .map((m) => `${m.role}: ${m.text}`);
        const hospitalName = hospitalDoc?.name?.trim() || "Our hospital";
        const hospitalPhone = formatHospitalPhoneFromDoc(hospitalDoc);
        const aiReply = await answerGeneralQuestion(userText, {
          recentSnippets: recent,
          hospitalName,
          hospitalPhone,
        });

        const care = userSeemsToNeedCareGuidance(userText);
        const bookHint = care
          ? `\n\n*Appointment*\nIf you would like to schedule a visit at *${hospitalName}*, reply with *appointment* and we will guide you through the next steps.`
          : "";
        const fullReply = aiReply + bookHint;

        const useInteractive =
          care &&
          !isWhatsApiConfigured() &&
          outbound.phoneNumberId &&
          outbound.accessToken;

        result = {
          reply: fullReply,
          interactive:
            useInteractive
              ? {
                  body:
                    aiReply +
                    `\n\n*Appointment*\nWould you like to book a visit at *${hospitalName}*? Tap *Book appointment* below, or reply *appointment*.`,
                  buttons: [
                    { id: "book_appt", title: "Book appointment" },
                    { id: "get_rx", title: "Prescriptions" },
                  ],
                }
              : undefined,
        };
      }
    }
  } catch (err) {
    console.error("[whatsapp-chat-agent] handler error:", err.message, err.stack || "");
    result = {
      reply:
        "We're sorry — we couldn't process your message just now.\n\nPlease try again in a few moments. If your need is urgent, please call the hospital directly.",
    };
  }

  if (result?.reply) {
    appendMessage(from, "assistant", result.reply);
    try {
      await sendReply(outbound, from, result.reply, {
        interactiveBody: result.interactive?.body,
        interactiveButtons: result.interactive?.buttons,
      });
    } catch (sendErr) {
      console.error(
        "[whatsapp-chat-agent] sendReply failed (no user delivery):",
        sendErr.message,
        sendErr.details || sendErr.status || ""
      );
    }
  }

  if (result?.endFlow) {
    resetFlows(from);
  }
}

/**
 * Fire-and-forget replies: WhatsAPI send/text when configured, else Meta Cloud Graph.
 * @param {object} body - Meta webhook JSON
 */
function webhookHasInboundMessages(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const msgs = change.value?.messages;
      if (Array.isArray(msgs) && msgs.length) return true;
    }
  }
  return false;
}

function processWhatsAppWebhookBody(body) {
  const payloads = extractInboundPayloads(body);
  if (!payloads.length) {
    if (webhookHasInboundMessages(body)) {
      console.warn(
        "[whatsapp-chat-agent] Received message(s) but no usable text (types other than text/button/interactive are ignored)."
      );
    }
    return;
  }

  setImmediate(() => {
    (async () => {
      for (const p of payloads) {
        try {
          await routeOneMessage(p);
        } catch (err) {
          console.error("[whatsapp-chat-agent] message error:", err.message);
        }
      }
    })();
  });
}

module.exports = {
  processWhatsAppWebhookBody,
  extractInboundPayloads,
};
