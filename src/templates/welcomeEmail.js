function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {{ name?: string, hospitalName?: string | null, dashboardUrl?: string, appName?: string }} opts
 */
function buildWelcomeText({
  name,
  hospitalName,
  dashboardUrl,
  appName = "Samvaad AI",
}) {
  const greeting = name && String(name).trim() ? `Hi ${String(name).trim()},` : "Hi,";
  const hospitalLine = hospitalName
    ? `Your account is linked to ${hospitalName}.`
    : "Your new account is ready.";

  const dash = dashboardUrl
    ? `Open the dashboard: ${dashboardUrl}`
    : `Open the ${appName} dashboard using the URL your hospital shared (or ask your admin).`;

  return [
    `${appName} — welcome`,
    "",
    greeting,
    "",
    hospitalLine,
    "",
    "How to sign in and start working:",
    "",
    `1. ${dash}`,
    `2. Sign in with this email address and the password you used when you registered.`,
    `3. After you sign in, you will see your workspace and can start using ${appName}.`,
    "",
    "If you did not create this account, contact your hospital administrator.",
  ].join("\n");
}

/**
 * @param {{ name?: string, hospitalName?: string | null, dashboardUrl?: string, appName?: string }} opts
 */
function buildWelcomeHtml({
  name,
  hospitalName,
  dashboardUrl,
  appName = "Samvaad AI",
}) {
  const greeting =
    name && String(name).trim()
      ? `Hi ${escapeHtml(String(name).trim())},`
      : "Hi,";
  const hospitalLine = hospitalName
    ? `<p>Your account is linked to <strong>${escapeHtml(hospitalName)}</strong>.</p>`
    : `<p>Your new account is ready.</p>`;

  const step1 = dashboardUrl
    ? `<p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Open ${escapeHtml(
        appName,
      )} dashboard</a></p><p style="word-break:break-all;font-size:14px;color:#444;">${escapeHtml(
        dashboardUrl,
      )}</p>`
    : `<p>Open the <strong>${escapeHtml(appName)}</strong> dashboard using the URL your hospital shared (or ask your admin).</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Welcome to ${escapeHtml(appName)}</title>
</head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.5; color: #111;">
  <p><strong>${escapeHtml(appName)}</strong> — welcome</p>
  <p>${greeting}</p>
  ${hospitalLine}
  <p><strong>How to sign in and start working</strong></p>
  <ol style="padding-left: 1.25rem;">
    <li style="margin-bottom: 0.75rem;">${step1}</li>
    <li style="margin-bottom: 0.75rem;">Sign in with <strong>this email address</strong> and the <strong>password</strong> you used when you registered.</li>
    <li>After you sign in, you will see your workspace and can start using ${escapeHtml(appName)}.</li>
  </ol>
  <p style="font-size:14px;color:#666;">If you did not create this account, contact your hospital administrator.</p>
</body>
</html>`;
}

module.exports = {
  buildWelcomeText,
  buildWelcomeHtml,
};
