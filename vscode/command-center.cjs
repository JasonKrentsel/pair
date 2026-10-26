'use strict';
const crypto = require('node:crypto');
const { commandMarkup, commandCss, outputMarkup, outputScript } = require('./command-view.cjs');
const { markdown } = require('./feedback-ui.cjs');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function renderCommandCenter(snapshot, index, root, progress, connected) {
  const change = snapshot.changes[index], nonce = crypto.randomBytes(16).toString('hex');
  const initial = progress || { status: 'Not run', text: 'This command has not run. Approve the step in the Pair sidebar when ready.', truncated: false };
  const identity = JSON.stringify({ reviewId: snapshot.id }).replace(/</g,'\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
  ${commandCss}
  *{box-sizing:border-box}html,body{height:100%;margin:0}body{padding:20px 28px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.5 var(--vscode-font-family);display:flex;flex-direction:column;gap:14px;overflow:hidden}
  header{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-shrink:0}h1{font-size:1.25em;margin:0}h2{font-size:1em;margin:0 0 6px}.muted{color:var(--vscode-descriptionForeground)}button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:6px 12px;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,pre:focus-visible{outline:1px solid var(--vscode-focusBorder)}
  .overview{flex:0 1 auto;max-height:44vh;overflow:auto}.why{max-width:100ch}.why p{margin:0 0 10px}.cwd{overflow-wrap:anywhere;margin-bottom:8px}.command-source{margin:0;background:var(--vscode-textCodeBlock-background);font:var(--vscode-editor-font-size)/1.6 var(--vscode-editor-font-family);max-height:28vh}
  .command-output{display:flex;flex-direction:column;flex:1 1 0;min-height:100px;margin:0}.command-output pre{flex:1;min-height:0;max-height:none;overflow:auto;margin:0;padding:14px 18px;background:var(--vscode-textCodeBlock-background);font:var(--vscode-editor-font-size)/1.6 var(--vscode-editor-font-family);overflow-wrap:anywhere}.output-heading{padding:8px 14px;flex-shrink:0}.output-note{flex-shrink:0}#connection{font-size:.9em;min-height:1.5em;flex-shrink:0}code{font-family:var(--vscode-editor-font-family)}
  @media(max-width:600px){body{padding:12px;gap:10px}header{align-items:flex-start}header button{max-width:160px}.overview{max-height:48vh}}
  </style></head><body><header><div><div class="muted">Action ${index+1} of ${snapshot.changes.length} · ${esc(change.kind)}</div><h1>${esc(snapshot.title)}</h1></div><button id="source">Open source / inline feedback</button></header>
  <section class="overview"><h2>Why this command runs</h2><div class="why">${markdown(change.why || snapshot.why)}</div><div class="cwd muted">Working directory · ${esc(change.cwd || root)}</div>${commandMarkup(change.command)}</section>
  ${outputMarkup(index, initial)}<div id="connection" class="muted">${connected ? 'Approvals and step navigation are in the Pair sidebar.' : 'Disconnected · showing the last recorded output.'}</div>
  <script nonce="${nonce}">const api=acquireVsCodeApi();const identity=${identity};${outputScript}document.getElementById('source').addEventListener('click',()=>api.postMessage({action:'source'}));window.addEventListener('message',event=>{if(event.data?.type==='connection')document.getElementById('connection').textContent=event.data.text;});</script></body></html>`;
}

function createCommandCenter(vscode, context, options) {
  let panel, target, shownOutput, lastRunning, connection;
  function output(state) {
    if (!target || state.sessionId !== target.sessionId || state.review?.id !== target.snapshot.id) return undefined;
    const change = state.review.changes[target.index];
    if (change?.command !== target.snapshot.changes[target.index].command) return undefined;
    const live = state.progress?.find(p=>p.reviewId === target.snapshot.id && p.index === target.index);
    if (live) return live;
    if (/Completed|Failed|Stopped/.test(change.status || '') && typeof change.text === 'string') return { index:target.index,reviewId:target.snapshot.id,status:change.status,text:change.text.slice(-32768),truncated:change.text.length>32768 };
  }
  function open(snapshot,index) {
    const state = options.getState();
    if (!state.sessionId || typeof snapshot?.changes[index]?.command !== 'string') return;
    target = { sessionId:state.sessionId, snapshot:structuredClone(snapshot), index };
    if (!panel) {
      panel = vscode.window.createWebviewPanel('pair.command','Command & Output',vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[],retainContextWhenHidden:true});
      const current = panel;
      panel.onDidDispose(()=>{if(panel===current){panel=undefined;target=undefined;}},undefined,context.subscriptions);
      panel.webview.onDidReceiveMessage(message=>{if(message?.action==='source')void openSource().catch(options.showError);},undefined,context.subscriptions);
    }
    panel.title = `Command ${index+1} · ${snapshot.title}`;
    const progress = output(state);
    shownOutput = JSON.stringify(progress);
    connection = undefined;
    panel.webview.html = renderCommandCenter(snapshot,index,state.root,progress,state.connected);
    panel.reveal(vscode.ViewColumn.Active,false);
  }
  async function openSource() {
    if (!target) return;
    if (options.getState().sessionId !== target.sessionId) throw new Error('This command belongs to another Pi session. Open its current review.');
    await options.openNative(target.snapshot,target.index);
  }
  function sync() {
    const state = options.getState();
    const running = state.connected && state.progress?.find(p=>p.reviewId===state.review?.id && p.status==='Running');
    const key = running && `${state.sessionId}:${running.reviewId}:${running.index}`;
    if (key && key!==lastRunning) { lastRunning=key; open(state.review,running.index); }
    if (!panel || !target) return;
    const progress = output(state), signature=JSON.stringify(progress);
    if (progress && signature!==shownOutput) {shownOutput=signature;void panel.webview.postMessage({type:'command-output',reviewId:target.snapshot.id,progress:[progress]});}
    const message = !state.connected ? 'Disconnected · showing the last recorded output.' : state.sessionId!==target.sessionId || state.review?.id!==target.snapshot.id ? 'Earlier step · showing its recorded command and output.' : 'Approvals and step navigation are in the Pair sidebar.';
    if(connection!==message){connection=message;void panel.webview.postMessage({type:'connection',text:message});}
  }
  context.subscriptions.push({dispose(){panel?.dispose();}});
  return {open,sync,openSource,getState:()=>({open:!!panel,reviewId:target?.snapshot.id,index:target?.index})};
}
module.exports={renderCommandCenter,createCommandCenter};
