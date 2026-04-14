/**
 * Server-hosted reset page: form posts JSON to /api/auth/reset-password.
 * @param {{ token: string }} opts
 */
function buildResetPasswordPageHtml({ token }) {
  const t = JSON.stringify(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Set a new password</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #111; }
    .card { max-width: 420px; margin: 40px auto; background: #fff; padding: 24px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #444; font-size: 14px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 16px; }
    button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 8px; background: #111; color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .msg { margin-top: 12px; font-size: 14px; }
    .err { color: #b00020; }
    .ok { color: #0d6b2c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Set a new password</h1>
    <p>This page is only valid for <strong>2 minutes</strong> after the email was sent. If it expired, request a new link.</p>
    <form id="f">
      <label for="pw">New password (min 6 characters)</label>
      <input id="pw" name="password" type="password" autocomplete="new-password" minlength="6" required />
      <button type="submit" id="btn">Update password</button>
    </form>
    <div id="out" class="msg" role="status"></div>
  </div>
  <script>
    (function () {
      var token = ${t};
      var form = document.getElementById('f');
      var out = document.getElementById('out');
      var btn = document.getElementById('btn');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        out.textContent = '';
        out.className = 'msg';
        var pw = document.getElementById('pw').value;
        btn.disabled = true;
        fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, password: pw })
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            if (x.ok && x.j && x.j.success) {
              out.className = 'msg ok';
              out.textContent = 'Password updated. You can close this tab and sign in.';
              form.style.display = 'none';
            } else {
              out.className = 'msg err';
              out.textContent = (x.j && x.j.message) ? x.j.message : 'Something went wrong.';
            }
          })
          .catch(function () {
            out.className = 'msg err';
            out.textContent = 'Network error. Try again.';
          })
          .finally(function () { btn.disabled = false; });
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = { buildResetPasswordPageHtml };
