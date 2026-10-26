'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderWebview}=require('../webview.cjs');
const assets={'app.js':'https://extension.vscode-resource.vscode-cdn.net/media/ui/app.js','app.css':'https://extension.vscode-resource.vscode-cdn.net/media/ui/app.css'};

test('React shell loads only bundled assets under a nonce policy and preserves hostile data as JSON',()=>{
  const state={review:{title:'</script><script>alert("bad")</script>',why:'<img src=x onerror=alert(1)>\u2028\u2029'},activeConversationId:'chat-1'};
  const html=renderWebview({state,assets,cspSource:'https://extension.vscode-resource.vscode-cdn.net'});
  const initial=html.match(/<script id="pair-bootstrap"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(initial),state);assert.doesNotMatch(initial,/<\/script>|<img/);
  assert.match(html,/default-src 'none'/);assert.match(html,/script-src 'nonce-[a-f0-9]{32}'/);
  assert.doesNotMatch(html,/unsafe-eval|unsafe-inline|localhost|127\.0\.0\.1/);
  assert.match(html,/<script type="module" nonce="[a-f0-9]{32}" src="https:\/\/extension\.vscode-resource\.vscode-cdn\.net\/media\/ui\/app\.js"><\/script>/);
  assert.match(html,/<link rel="stylesheet" href="https:\/\/extension\.vscode-resource\.vscode-cdn\.net\/media\/ui\/app\.css">/);
  assert.equal((html.match(/<script /g)||[]).length,2);assert.match(html,/<div id="root"><\/div>/);
});

test('each shell gets a fresh matching nonce and asset attributes stay escaped',()=>{
  const one=renderWebview({state:{},assets:{'app.js':'local" onload="bad','app.css':'local" style="bad'}});
  const two=renderWebview({state:{},assets});
  const nonce=one.match(/script-src 'nonce-([a-f0-9]+)'/)[1];
  assert.equal((one.match(new RegExp('nonce="'+nonce+'"','g'))||[]).length,2);
  assert.notEqual(nonce,two.match(/script-src 'nonce-([a-f0-9]+)'/)[1]);
  assert.match(one,/local&quot; onload=&quot;bad/);assert.doesNotMatch(one,/src="local" onload="/);
});
