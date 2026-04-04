/**
 * WhatsApp Cloud API — send messages (Graph).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */

const DEFAULT_API_VERSION = "v21.0";

/**
 * Build digits-only `to` for Cloud API (country code + national number, no +).
 * @param {string} phoneRaw - e.g. "9876543210", "+91 98765 43210"
 * @param {string} [defaultCountryDigits] - e.g. "91" when local 10-digit numbers are used
 */
function normalizeWhatsAppTo(phoneRaw, defaultCountryDigits = "91") {
  const cc = String(defaultCountryDigits || "91").replace(/\D/g, "") || "91";
  let digits = String(phoneRaw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) digits = `${cc}${digits}`;
  return digits;
}

function messagesUrl(phoneNumberId, apiVersion = DEFAULT_API_VERSION) {
  const ver = apiVersion || DEFAULT_API_VERSION;
  return `https://graph.facebook.com/${ver}/${phoneNumberId}/messages`;
}

/**
 * Low-level POST to /messages.
 * @param {object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.accessToken
 * @param {object} params.payload - full JSON body (messaging_product, to, type, ...)
 * @param {string} [params.apiVersion]
 * @returns {Promise<object>} Graph JSON
 */
async function graphSendMessages({ phoneNumberId, accessToken, payload, apiVersion }) {
  const res = await fetch(messagesUrl(phoneNumberId, apiVersion), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `WhatsApp API HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

/**
 * Send a plain text message.
 * @param {object} opts
 * @param {string} opts.phoneNumberId
 * @param {string} opts.accessToken
 * @param {string} opts.to - Phone (will be normalized if `defaultCountryDigits` passed)
 * @param {string} opts.textBody
 * @param {string} [opts.defaultCountryDigits]
 * @param {string} [opts.apiVersion]
 */
async function sendWhatsAppText({
  phoneNumberId,
  accessToken,
  to,
  textBody,
  defaultCountryDigits,
  apiVersion,
}) {
  const toDigits = defaultCountryDigits
    ? normalizeWhatsAppTo(to, defaultCountryDigits)
    : normalizeWhatsAppTo(to);
  if (!toDigits) {
    throw new Error("Invalid WhatsApp recipient phone");
  }

  return graphSendMessages({
    phoneNumberId,
    accessToken,
    apiVersion,
    payload: {
      messaging_product: "whatsapp",
      to: toDigits,
      type: "text",
      text: { body: textBody },
    },
  });
}

/**
 * Send an interactive reply-buttons message (max 3 buttons; title max 20 chars each).
 * @param {object} opts
 * @param {string} opts.phoneNumberId
 * @param {string} opts.accessToken
 * @param {string} opts.to
 * @param {string} opts.bodyText - main body (max 1024 per Cloud API)
 * @param {{ id: string, title: string }[]} opts.buttons
 * @param {string} [opts.defaultCountryDigits]
 * @param {string} [opts.apiVersion]
 */
async function sendWhatsAppInteractiveButtons({
  phoneNumberId,
  accessToken,
  to,
  bodyText,
  buttons,
  defaultCountryDigits,
  apiVersion,
}) {
  const toDigits = defaultCountryDigits
    ? normalizeWhatsAppTo(to, defaultCountryDigits)
    : normalizeWhatsAppTo(to);
  if (!toDigits) {
    throw new Error("Invalid WhatsApp recipient phone");
  }

  const list = (Array.isArray(buttons) ? buttons : [])
    .slice(0, 3)
    .map((b) => ({
      type: "reply",
      reply: {
        id: String(b.id || "btn").slice(0, 256),
        title: String(b.title || "OK").slice(0, 20),
      },
    }));

  if (!list.length) {
    throw new Error("sendWhatsAppInteractiveButtons: at least one button required");
  }

  const body = String(bodyText || "").trim().slice(0, 1024);

  return graphSendMessages({
    phoneNumberId,
    accessToken,
    apiVersion,
    payload: {
      messaging_product: "whatsapp",
      to: toDigits,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: list },
      },
    },
  });
}

/**
 * Send a template message.
 * @param {object} opts
 * @param {string} opts.phoneNumberId
 * @param {string} opts.accessToken
 * @param {string} opts.to
 * @param {string} opts.templateName
 * @param {string} [opts.languageCode="en"]
 * @param {object[]} [opts.components] - Graph `template.components` (headers/buttons/etc.)
 * @param {string} [opts.defaultCountryDigits]
 * @param {string} [opts.apiVersion]
 */
async function sendWhatsAppTemplate({
  phoneNumberId,
  accessToken,
  to,
  templateName,
  languageCode = "en",
  components = [],
  defaultCountryDigits,
  apiVersion,
}) {
  const toDigits = defaultCountryDigits
    ? normalizeWhatsAppTo(to, defaultCountryDigits)
    : normalizeWhatsAppTo(to);
  if (!toDigits) {
    throw new Error("Invalid WhatsApp recipient phone");
  }

  return graphSendMessages({
    phoneNumberId,
    accessToken,
    apiVersion,
    payload: {
      messaging_product: "whatsapp",
      to: toDigits,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    },
  });
}

/**
 * Build a single template `body` component from ordered text parameters (variable {{1}}, {{2}}, …).
 * @param {string[]} texts
 * @returns {{ type: string, parameters: { type: string, text: string }[] }[]}
 */
function templateBodyParameters(texts) {
  const list = Array.isArray(texts) ? texts : [];
  return [
    {
      type: "body",
      parameters: list.map((text) => ({ type: "text", text: String(text ?? "") })),
    },
  ];
}

/**
 * Body component for templates with PARAMETER_FORMAT NAMED ({{patient_name}}, …).
 * @param {Record<string, string>} namedValues - keys must match template variable names
 * @returns {{ type: string, parameters: object[] }[]}
 */
function templateBodyNamedParameters(namedValues) {
  const o = namedValues && typeof namedValues === "object" ? namedValues : {};
  const parameters = Object.keys(o).map((parameter_name) => ({
    type: "text",
    text: String(o[parameter_name] ?? ""),
    parameter_name,
  }));
  return [{ type: "body", parameters }];
}

module.exports = {
  DEFAULT_API_VERSION,
  normalizeWhatsAppTo,
  messagesUrl,
  graphSendMessages,
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppTemplate,
  templateBodyParameters,
  templateBodyNamedParameters,
};
