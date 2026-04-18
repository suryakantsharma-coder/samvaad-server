const env = require("../config/env");
const {
  buildPasswordResetHtml,
  buildPasswordResetText,
} = require("../templates/passwordResetEmail");
const {
  buildWelcomeHtml,
  buildWelcomeText,
} = require("../templates/welcomeEmail");

/** @see https://api-docs.mailtrap.io — transactional send */
const MAILTRAP_SEND_URL = "https://send.api.mailtrap.io/api/send";

const DEFAULT_FROM_NAME = "Samvaad";

/**
 * Parse MAIL_FROM: `Name <email@domain>`, quoted name, or plain email.
 * @returns {{ name: string, email: string }}
 */
function parseMailFrom(mailFrom) {
  const s = String(mailFrom || "").trim();
  const quoted = s.match(/^"([^"]+)"\s*<([^>]+)>$/);
  if (quoted) {
    return { name: quoted[1].trim() || DEFAULT_FROM_NAME, email: quoted[2].trim() };
  }
  const angled = s.match(/^([^<]+)<([^>]+)>$/);
  if (angled) {
    const name = angled[1].trim() || DEFAULT_FROM_NAME;
    return { name, email: angled[2].trim() };
  }
  if (/^\S+@\S+$/.test(s)) {
    return { name: DEFAULT_FROM_NAME, email: s };
  }
  return { name: DEFAULT_FROM_NAME, email: s };
}

function isMailConfigured() {
  return Boolean(env.MAILTRAP_API_KEY && env.MAIL_FROM);
}

/**
 * Same contract as:
 * curl -X POST 'https://send.api.mailtrap.io/api/send' \
 *   -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
 *   -d '{"from":{"email":"...","name":"..."},"to":[{"email":"..."}],"subject":"...","text":"...","category":"..."}'
 *
 * @param {object} body
 * @returns {Promise<object>}
 */
function parseMailtrapResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Mailtrap accepts `Authorization: Bearer` or `Api-Token`. Retry with the other style on 401
 * in case the token was copied from an integration sample that uses a different header.
 */
async function postMailtrapSend(body) {
  const token = env.MAILTRAP_API_KEY;
  const send = (authHeaders) =>
    fetch(MAILTRAP_SEND_URL, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let res = await send({ Authorization: `Bearer ${token}` });
  if (res.status === 401) {
    res = await send({ "Api-Token": token });
  }

  const text = await res.text();
  const data = parseMailtrapResponseBody(text);

  if (!res.ok) {
    let msg =
      (data && Array.isArray(data.errors) && data.errors.join("; ")) ||
      (data && data.message) ||
      (typeof data?.raw === "string" && data.raw) ||
      text ||
      `HTTP ${res.status}`;

    if (res.status === 401) {
      msg = `${msg}. Mailtrap 401: use the Transactional API token from Sending Domains → your domain → Integration (not the Email Sandbox testing token). MAIL_FROM must use that verified domain. See https://docs.mailtrap.io/email-api-smtp/help/troubleshooting/unauthorized-401-error`;
    }

    const err = new Error(msg);
    err.statusCode = res.status >= 500 ? 503 : res.status;
    err.mailtrapResponse = data;
    throw err;
  }

  return data;
}

/**
 * @param {{ to: string, resetUrl: string }} opts
 */
async function sendPasswordResetMail({ to, resetUrl }) {
  const { email, name } = parseMailFrom(env.MAIL_FROM);
  const subject = "Reset your password";
  const text = buildPasswordResetText({ resetUrl });
  const html = buildPasswordResetHtml({ resetUrl });

  if (!isMailConfigured()) {
    console.error(
      "[mail] Password reset: cannot send — set MAILTRAP_API_KEY and MAIL_FROM",
    );
    const err = new Error(
      "Email is not configured (set MAILTRAP_API_KEY and MAIL_FROM)",
    );
    err.statusCode = 503;
    throw err;
  }

  const payload = {
    from: { email, name },
    to: [{ email: to }],
    subject,
    text,
    html,
    category: env.MAILTRAP_EMAIL_CATEGORY || "password_reset",
  };

  try {
    const result = await postMailtrapSend(payload);
    console.log("[mail] Password reset email sent OK", {
      to,
      mailtrapResponse: result ?? null,
    });
  } catch (err) {
    console.error("[mail] Password reset email FAILED (not sent):", err.message, {
      fromEmail: email,
    });
    if (err.stack) console.error(err.stack);
    throw err;
  }
}

/**
 * Welcome email after POST /api/auth/register. Best-effort: never throws (registration must still succeed).
 * @param {{ to: string, name?: string, hospitalName?: string | null, dashboardUrl?: string }} opts
 */
async function sendWelcomeMail({ to, name, hospitalName, dashboardUrl = "" }) {
  const { email, name: fromName } = parseMailFrom(env.MAIL_FROM);
  const subject = "Welcome to Samvaad AI";
  const text = buildWelcomeText({ name, hospitalName, dashboardUrl });
  const html = buildWelcomeHtml({ name, hospitalName, dashboardUrl });

  if (!isMailConfigured()) {
    if (env.NODE_ENV !== "production") {
      console.warn(
        "[mail] Welcome email NOT sent — set MAILTRAP_API_KEY and MAIL_FROM. Registration still succeeded.",
      );
    } else {
      console.error(
        "[mail] Welcome email NOT sent — Mailtrap not configured in production (set MAILTRAP_API_KEY, MAIL_FROM)",
      );
    }
    return;
  }

  const payload = {
    from: { email, name: fromName },
    to: [{ email: to }],
    subject,
    text,
    html,
    category: env.MAILTRAP_EMAIL_CATEGORY || "welcome",
  };

  try {
    const result = await postMailtrapSend(payload);
    console.log("[mail] Welcome email sent OK", { to, mailtrapResponse: result ?? null });
  } catch (err) {
    console.error("[mail] Welcome email FAILED (registration still OK):", err.message, {
      to,
      fromEmail: email,
    });
    if (err.stack) console.error(err.stack);
  }
}

module.exports = {
  isMailConfigured,
  sendPasswordResetMail,
  sendWelcomeMail,
};
