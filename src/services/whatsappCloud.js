/**
 * WhatsApp Cloud API — send messages (Graph).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */

const DEFAULT_API_VERSION = "v21.0";

/**
 * India-only deployment: WhatsApp `to` must be country code + national number (digits, no +).
 * Used when the stored number has no country code (10-digit mobile).
 */
const DEFAULT_WHATSAPP_COUNTRY_DIGITS = "91";

/**
 * Build digits-only `to` for Cloud API / WhatsAPI (country code + national number, no +).
 * - 10-digit numbers → prefixed with default country (India **91** by default).
 * - Already includes country code (e.g. 91… or +91…) → unchanged.
 * - Leading `00` international prefix stripped; leading national `0` (11-digit 0XXXXXXXXXX) stripped.
 *
 * @param {string|null|undefined} phoneRaw - e.g. "9876543210", "+91 98765 43210", "919876543210"
 * @param {string} [defaultCountryDigits="91"] - ITU country calling code digits (no +)
 */
function normalizeWhatsAppTo(phoneRaw, defaultCountryDigits = DEFAULT_WHATSAPP_COUNTRY_DIGITS) {
  const cc =
    String(defaultCountryDigits || DEFAULT_WHATSAPP_COUNTRY_DIGITS).replace(/\D/g, "") ||
    DEFAULT_WHATSAPP_COUNTRY_DIGITS;

  let digits = String(phoneRaw ?? "")
    .trim()
    .replace(/\D/g, "");
  if (!digits) return null;

  while (digits.startsWith("00") && digits.length > 2) {
    digits = digits.slice(2);
  }

  // Indian national trunk: 0 + 10-digit mobile → 11 digits
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // Already has country code (e.g. 91 + 10-digit mobile = 12 digits)
  if (digits.startsWith(cc) && digits.length >= cc.length + 10) {
    return digits;
  }

  // Local mobile without country code (10 digits)
  if (digits.length === 10) {
    return `${cc}${digits}`;
  }

  // Longer international-style number without leading +
  if (digits.length >= 11) {
    return digits;
  }

  return null;
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
    // Meta nests the actionable reason under error.error_data.details
    // (e.g. "number of parameters does not match"). Surface it in the message.
    const nestedDetail =
      data.error?.error_data?.details ||
      (Array.isArray(data.error?.error_data)
        ? data.error.error_data[0]?.details
        : "");
    const baseMsg = data.error?.message || `WhatsApp API HTTP ${res.status}`;
    const msg = nestedDetail ? `${baseMsg} — ${nestedDetail}` : baseMsg;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data;
    err.apiDetail = nestedDetail || null;
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
  const toDigits = normalizeWhatsAppTo(
    to,
    defaultCountryDigits ?? DEFAULT_WHATSAPP_COUNTRY_DIGITS,
  );
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
  const toDigits = normalizeWhatsAppTo(
    to,
    defaultCountryDigits ?? DEFAULT_WHATSAPP_COUNTRY_DIGITS,
  );
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
  const toDigits = normalizeWhatsAppTo(
    to,
    defaultCountryDigits ?? DEFAULT_WHATSAPP_COUNTRY_DIGITS,
  );
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
  DEFAULT_WHATSAPP_COUNTRY_DIGITS,
  normalizeWhatsAppTo,
  messagesUrl,
  graphSendMessages,
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppTemplate,
  templateBodyParameters,
  templateBodyNamedParameters,
};
