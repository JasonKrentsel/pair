'use strict';
const crypto = require('node:crypto');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// The React app is bundled locally. No dev server, remote scripts, inline event
// handlers or untrusted HTML enter the installed extension's webview.
function renderWebview({state, assets, cspSource = "'self'"}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const initial = JSON.stringify(state).replace(/</g, '\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${escape(cspSource)}; font-src ${escape(cspSource)}; img-src ${escape(cspSource)} data:;"><link rel="stylesheet" href="${escape(assets['app.css'])}"><title>Pair</title></head><body><div id="root"></div><script id="pair-bootstrap" type="application/json" nonce="${nonce}">${initial}</script><script type="module" nonce="${nonce}" src="${escape(assets['app.js'])}"></script></body></html>`;
}
module.exports = {renderWebview};
