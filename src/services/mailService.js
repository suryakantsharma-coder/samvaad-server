const nodemailer = require('nodemailer');
const env = require('../config/env');
const { buildPasswordResetHtml, buildPasswordResetText } = require('../templates/passwordResetEmail');

let transporter;

function isMailConfigured() {
  return Boolean(env.SMTP_HOST && env.MAIL_FROM);
}

/**
 * Port 465 = implicit TLS (SMTPS) → secure: true.
 * Port 587 / 25 / 2525 = plain socket then STARTTLS → secure: false.
 * SMTP_SECURE=true on 587 causes OpenSSL "wrong version number" (TLS client vs plain SMTP banner).
 */
function resolveSmtpSecure(port, explicitSecure) {
  if (port === 465) {
    if (!explicitSecure) {
      console.warn(
        '[mail] SMTP: port 465 uses implicit TLS; using secure: true (set SMTP_SECURE=true or omit).'
      );
    }
    return true;
  }
  if (explicitSecure) {
    console.warn(
      `[mail] SMTP: SMTP_SECURE=true on port ${port} breaks most providers; using secure: false (STARTTLS). Use port 465 for SMTPS.`
    );
    return false;
  }
  return false;
}

function getTransporter() {
  if (!isMailConfigured()) return null;
  if (!transporter) {
    const port = env.SMTP_PORT;
    const secure = resolveSmtpSecure(port, env.SMTP_SECURE);
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure,
      auth:
        env.SMTP_USER || env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }
  return transporter;
}

/**
 * @param {{ to: string, resetUrl: string }} opts
 */
async function sendPasswordResetMail({ to, resetUrl }) {
  const from = env.MAIL_FROM;
  const transport = getTransporter();
  const subject = 'Reset your password';
  const text = buildPasswordResetText({ resetUrl });
  const html = buildPasswordResetHtml({ resetUrl });

  if (!transport) {
    console.error('[mail] Password reset: cannot send — transporter missing (set SMTP_HOST and MAIL_FROM)');
    const err = new Error('Email is not configured (set SMTP_HOST and MAIL_FROM)');
    err.statusCode = 503;
    throw err;
  }

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
    const preview = info.response
      ? String(info.response).slice(0, 160)
      : '';
    console.log('[mail] Password reset email sent OK', {
      to,
      messageId: info.messageId || null,
      accepted: info.accepted,
      rejected: info.rejected,
      responsePreview: preview || undefined,
    });
  } catch (err) {
    console.error('[mail] Password reset email FAILED (not sent):', err.message);
    if (err.stack) console.error(err.stack);
    throw err;
  }
}

module.exports = {
  isMailConfigured,
  sendPasswordResetMail,
};
