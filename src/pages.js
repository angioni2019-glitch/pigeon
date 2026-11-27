'use strict';
// The one web page the bridge serves: entering the Telegram 2-step
// verification password from the phone instead of typing it on the watch.
// The watch shows this page's address as a QR code.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#0e1621;--card:#17212b;--fg:#e9eef3;--sub:#8b9bab;--accent:#3a9be0;--err:#ef5b5b}
@media (prefers-color-scheme:light){:root{--bg:#f1f4f7;--card:#fff;--fg:#14202b;--sub:#5c6b79}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px}
.card{width:100%;max-width:380px;background:var(--card);border-radius:16px;padding:26px 22px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 14px;color:var(--sub)}
label{display:block;font-size:14px;color:var(--sub);margin:16px 0 6px}
input{width:100%;font:inherit;padding:12px 14px;border-radius:10px;border:1px solid #3b4a58;background:transparent;color:var(--fg)}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff}
.err{color:var(--err);margin-top:12px}.ok{font-size:44px;text-align:center;margin:4px 0 8px}
.small{font-size:13px;margin-top:18px}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function passwordForm({ hint, error }) {
  return layout(
    'Pigeon - 2-step verification',
    `<h1>Two-step verification</h1>
<p>Your Telegram account has a cloud password. Enter it to finish linking your watch.</p>
<form method="post" autocomplete="off">
<label for="pw">Password${hint ? ` (hint: ${esc(hint)})` : ''}</label>
<input id="pw" name="password" type="password" required autofocus autocomplete="current-password">
<button type="submit">Continue</button>
${error ? `<p class="err">${esc(error)}</p>` : ''}
</form>
<p class="small">Pigeon is an unofficial client that uses the Telegram API. The password is sent to Telegram and is not stored.</p>`,
  );
}

function done() {
  return layout('Pigeon - linked', '<div class="ok">✓</div><h1>Done</h1><p>Your watch is now linked. You can close this page.</p>');
}

function gone() {
  return layout(
    'Pigeon - link expired',
    '<h1>This link has expired</h1><p>Open Pigeon on your watch and start linking again. A new code will be shown.</p>',
  );
}

module.exports = { passwordForm, done, gone };
