/**
 * Basic password-reset email bodies (plain text + HTML).
 * @param {{ resetUrl: string, appName?: string }} opts
 */
function buildPasswordResetText({ resetUrl, appName = 'Samvaad' }) {
  return [
    `${appName} — reset your password`,
    '',
    `Open this link (valid for 2 minutes only):`,
    resetUrl,
    '',
    `If you did not request this, you can ignore this email.`,
  ].join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPasswordResetHtml({ resetUrl, appName = 'Samvaad' }) {
  const href = escapeHtml(resetUrl);
  const visible = escapeHtml(resetUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reset your password</title>
</head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.5; color: #111;">
  <p><strong>${appName}</strong> — password reset</p>
  <p>This link expires in <strong>2 minutes</strong>.</p>
  <p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Reset password</a></p>
  <p style="word-break:break-all;font-size:14px;color:#444;">${visible}</p>
  <p style="font-size:14px;color:#666;">If you did not request this, you can ignore this email.</p>
</body>
</html>`;
}

module.exports = {
  buildPasswordResetText,
  buildPasswordResetHtml,
};
