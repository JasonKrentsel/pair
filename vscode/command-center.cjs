'use strict';
const crypto = require('node:crypto');
const { commandMarkup, commandCss, outputMarkup, outputScript } = require('./command-view.cjs');
const { markdown } = require('./markdown.cjs');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const commandCenterCss = `
  *{box-sizing:border-box}html,body{height:100%;margin:0}
  body{padding:20px 24px;color:var(--vscode-editor-foreground,#ddd);background:var(--vscode-editor-background,#1e1e1e);font:14px/1.6 var(--vscode-font-family,system-ui,sans-serif);display:flex;flex-direction:column;gap:16px;overflow:hidden}
  header{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-shrink:0;min-width:0}
  .command-title{min-width:0}.title-row{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}h1{font-size:16px;line-height:1.4;margin:0;font-weight:600}.shell-name{font-size:12px;color:var(--vscode-editor-foreground,#ddd)}
  .step-name{font-size:12px;margin:4px 0 0;color:var(--vscode-descriptionForeground,#bbb);overflow-wrap:anywhere;max-width:110ch}
  .muted{color:var(--vscode-descriptionForeground,#bbb)}
  button{font:12px/1.4 var(--vscode-font-family,system-ui,sans-serif);color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground,#ddd));background:var(--vscode-button-secondaryBackground,transparent);border:1px solid var(--vscode-panel-border,#444);border-radius:6px;padding:6px 10px;min-height:30px;cursor:pointer;white-space:nowrap;transition:background-color 120ms,border-color 120ms}
  button:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-list-hoverBackground,#2a2a2a))}button:disabled{opacity:.5;cursor:default}button[hidden]{display:none}button:focus-visible,pre:focus-visible{outline:2px solid var(--vscode-focusBorder,#007fd4);outline-offset:2px}
  .overview{flex:0 1 auto;max-height:43vh;overflow:auto;min-height:0;scrollbar-gutter:stable}
  .why{max-width:100ch;color:var(--vscode-editor-foreground,#ddd);font-size:14px;line-height:1.65}.why p{margin:0 0 8px}.why p:last-child{margin-bottom:0}.why code{color:var(--vscode-textPreformat-foreground,var(--vscode-editor-foreground,#ddd));font-family:var(--vscode-editor-font-family,monospace);font-size:.93em}
  .command-context{margin:12px 0 16px;font-size:12px;line-height:1.55}.command-context>div{display:flex;gap:12px;align-items:baseline;min-width:0}.command-context dt{color:var(--vscode-descriptionForeground,#bbb);flex:none}.command-context dd{margin:0;min-width:0;overflow-wrap:anywhere;color:var(--vscode-editor-foreground,#ddd)}.command-context code{font:12px/1.55 var(--vscode-editor-font-family,monospace)}
  .source-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;font-size:12px}.source-toolbar strong{font-weight:600}.source-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.source-actions button{min-height:28px;padding:4px 8px}.source-hint{color:var(--vscode-descriptionForeground,#bbb);font-size:11px}
  pre{margin:0;tab-size:4;font:13px/1.65 var(--vscode-editor-font-family,monospace)}pre code{font:inherit;background:transparent}
  .exact-command{padding:12px 16px;max-height:24vh;overflow:auto;background:var(--vscode-textCodeBlock-background,#252525);border:1px solid var(--vscode-panel-border,#444);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
  .exact-command code{display:block;padding-left:2ch;text-indent:-2ch;white-space:inherit;overflow-wrap:inherit}.exact-command.multiline code{padding-left:0;text-indent:0}.exact-command.no-wrap{white-space:pre;overflow-wrap:normal}.exact-command.no-wrap code{padding-left:0;text-indent:0}
  .terminal-box,.command-output{display:flex;flex-direction:column;flex:1 1 0;min-height:120px;border:1px solid var(--vscode-panel-border,#444);border-radius:6px;overflow:hidden;margin:0}
  .toolbar,.output-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,#444);flex-shrink:0;font-size:12px}.toolbar strong,.output-heading strong{font-weight:600}.buttons{display:flex;align-items:center;gap:8px}
  #terminal{flex:1;min-height:0;padding:12px 16px;overflow:hidden}.command-output pre{flex:1;min-height:0;max-height:none;overflow:auto;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
  .terminal-footer,.output-note{padding:8px 12px;border-top:1px solid var(--vscode-panel-border,#444);flex-shrink:0;font-size:12px;line-height:1.5;color:var(--vscode-descriptionForeground,#bbb)}#input-status{color:var(--vscode-editor-foreground,#ddd)}#output-note:empty{display:none}
  #connection{font-size:12px;line-height:1.5;flex-shrink:0;color:var(--vscode-descriptionForeground,#bbb)}
  .hljs-keyword,.hljs-built_in,.hljs-selector-tag{color:var(--vscode-symbolIcon-keywordForeground,#c586c0)}.hljs-string,.hljs-regexp{color:var(--vscode-debugTokenExpression-string,#ce9178)}.hljs-variable,.hljs-template-variable,.hljs-params{color:var(--vscode-debugTokenExpression-name,#9cdcfe)}.hljs-number,.hljs-literal{color:var(--vscode-debugTokenExpression-number,#b5cea8)}.hljs-comment{color:var(--vscode-descriptionForeground,#bbb);font-style:italic}.hljs-title,.hljs-function{color:var(--vscode-symbolIcon-functionForeground,#dcdcaa)}
  @media(max-width:640px){body{padding:12px;gap:12px}header{gap:8px}.overview{max-height:48vh}.source-toolbar{align-items:flex-start}.source-hint{display:none}.source-actions{justify-content:flex-end;gap:4px}.command-context>div{display:block}.command-context dt{margin-bottom:2px}#terminal{padding:8px}.toolbar,.output-heading{padding:8px;gap:8px}}
  @media(prefers-reduced-motion:reduce){button{transition:none}}
  @media(forced-colors:active){button,.exact-command,.terminal-box,.command-output{border-color:CanvasText}}
`;

function commandHeader(snapshot,index) {
  const change=snapshot.changes[index];
  return `<header><div class="command-title"><div class="title-row"><h1>Command</h1><span class="shell-name">${esc(change.kind)} · Action ${index+1} of ${snapshot.changes.length}${change.interactive?' · Interactive':''}</span></div><p class="step-name">Step: ${esc(snapshot.title)}</p></div><button id="source">Open source</button></header>`;
}

function commandOverview(snapshot,index,root,highlighted) {
  const change=snapshot.changes[index];
  const source=highlighted?`<pre id="command-source" class="exact-command${/[\r\n]/.test(change.command)?' multiline':''}" tabindex="0" aria-label="Exact command"><code id="command-code" class="language-${/powershell/i.test(change.kind)?'powershell':'bash'}">${esc(change.command)}</code></pre>`:commandMarkup(change.command);
  return `<section class="overview" aria-label="Command details"><div class="why">${markdown(change.why||snapshot.why)}</div><dl class="command-context"><div><dt>Directory</dt><dd><code>${esc(change.cwd||root)}</code></dd></div></dl><div class="source-toolbar"><strong>Exact command</strong><div class="source-actions"><span id="source-hint" class="source-hint">Wrapped for reading</span><button id="wrap" aria-pressed="true" aria-controls="command-source">Wrap lines</button><button id="copy" aria-live="polite" title="Copy the exact command with its original line breaks">Copy command</button></div></div>${source}</section>`;
}

function renderCommandCenter(snapshot, index, root, progress, connected, assets) {
  const change = snapshot.changes[index], nonce = crypto.randomBytes(16).toString('hex');
  const initial = progress || { status: 'Not run', text: 'This command has not run. Approve the step in the Pair sidebar when ready.', truncated: false };
  const identity = JSON.stringify({ reviewId: snapshot.id }).replace(/</g,'\\u003c');
  if (assets) return renderTerminal(snapshot,index,root,initial,connected,assets,nonce);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
  ${commandCss}${commandCenterCss}
  </style></head><body>${commandHeader(snapshot,index)}
  ${commandOverview(snapshot,index,root,false)}
  ${outputMarkup(index, initial)}<div id="connection" class="muted">${connected ? 'Approvals and step navigation are in the Pair sidebar.' : 'Disconnected · showing the last recorded output.'}</div>
  <script nonce="${nonce}">const api=acquireVsCodeApi();const identity=${identity};${outputScript}document.getElementById('source').addEventListener('click',()=>api.postMessage({action:'source'}));document.getElementById('copy').addEventListener('click',()=>api.postMessage({action:'copy'}));document.getElementById('wrap').addEventListener('click',event=>{const wrapped=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(wrapped));document.getElementById('command-source').classList.toggle('no-wrap',!wrapped);document.getElementById('source-hint').textContent=wrapped?'Wrapped for reading':'Original line breaks';});window.addEventListener('message',event=>{if(event.data?.type==='connection')document.getElementById('connection').textContent=event.data.text;if(event.data?.type==='command-copied')document.getElementById('copy').textContent='Copied';});</script></body></html>`;
}

function createCommandCenter(vscode, context, options) {
  let panel, target, shownOutput, lastRunning, connection, terminalSignature, inputSequence=0, inputRun, inputQueue=Promise.resolve();
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
    inputRun=undefined;
    if (!panel) {
      panel = vscode.window.createWebviewPanel('pair.command','Command & Output',vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:context.extensionUri?[vscode.Uri.joinPath(context.extensionUri,'media')]:[],retainContextWhenHidden:true});
      const current = panel;
      panel.onDidDispose(()=>{if(panel===current){panel=undefined;target=undefined;}},undefined,context.subscriptions);
      panel.webview.onDidReceiveMessage(message=>{
        if(message?.action==='source')void openSource().catch(options.showError);
        if(message?.action==='copy')void copyCommand().catch(options.showError);
        if(message?.action==='ready'){shownOutput=undefined;terminalSignature=undefined;sync();}
        if(message?.action==='terminal')inputQueue=inputQueue.then(()=>sendTerminal(message)).catch(error=>{void panel?.webview.postMessage({type:'terminal-error',text:error.message});});
      },undefined,context.subscriptions);
    }
    panel.title = `Command ${index+1} · ${snapshot.title}`;
    const progress = output(state);
    shownOutput = JSON.stringify(progress);
    connection = undefined;
    const assets=context.extensionUri?Object.fromEntries(['vendor/xterm.js','vendor/xterm.css','vendor/addon-fit.js','vendor/highlight.js','vendor/powershell.js','terminal-client.js'].map(file=>[file,panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media',file)).toString()])):undefined;
    if(assets)assets.csp=panel.webview.cspSource;
    panel.webview.html = renderCommandCenter(snapshot,index,state.root,progress,state.connected,assets);
    panel.reveal(vscode.ViewColumn.Active,false);
  }
  async function openSource() {
    if (!target) return;
    if (options.getState().sessionId !== target.sessionId) throw new Error('This command belongs to another Pi session. Open its current review.');
    await options.openNative(target.snapshot,target.index);
  }
  async function copyCommand() {
    const copiedTarget=target,command=copiedTarget?.snapshot.changes[copiedTarget.index]?.command;
    if(typeof command!=='string')return;
    if(!vscode.env?.clipboard?.writeText)throw new Error('Clipboard is unavailable. Open the command source to copy it.');
    await vscode.env.clipboard.writeText(command);
    if(target===copiedTarget)void panel?.webview.postMessage({type:'command-copied'});
  }
  async function sendTerminal(message){
    const state=options.getState(), t=state.terminal;
    if(!state.connected||!vscode.workspace.isTrusted||!target||state.sessionId!==target.sessionId||t?.reviewId!==target.snapshot.id||t?.index!==target.index||message.runId!==t?.runId)throw new Error('This terminal is no longer active.');
    if(inputRun!==t.runId){inputRun=t.runId;inputSequence=Number.isSafeInteger(t.inputSequence)?t.inputSequence:0;}
    const base={runId:t.runId,reviewId:t.reviewId,index:t.index};
    if(message.kind==='input'){
      if(typeof message.text!=='string'||message.text.length>65536)throw new Error('Paste at most 64 KiB at a time.');
      for(let offset=0;offset<message.text.length;offset+=4096){if(options.getState().terminal?.runId!==t.runId)throw new Error('The command finished while pasting. Remaining input was discarded.');await options.sendTerminal({...base,action:'input',sequence:++inputSequence,text:message.text.slice(offset,offset+4096)});}
    }else if(message.kind==='resize')await options.sendTerminal({...base,action:'resize',cols:message.cols,rows:message.rows});
    else if(message.kind==='stop')await options.sendTerminal({...base,action:'stop'});
  }
  function sync() {
    const state = options.getState();
    const running = state.connected && state.progress?.find(p=>p.reviewId===state.review?.id && p.status==='Running');
    const key = running && `${state.sessionId}:${running.reviewId}:${running.index}`;
    if (key && key!==lastRunning) { lastRunning=key; open(state.review,running.index); }
    if (!panel || !target) return;
    const active=state.connected && state.sessionId===target.sessionId && state.terminal?.reviewId===target.snapshot.id && state.terminal?.index===target.index ? state.terminal : null;
    const terminalKey=JSON.stringify(active);
    if(terminalSignature!==terminalKey){terminalSignature=terminalKey;void panel.webview.postMessage({type:'terminal-state',terminal:active});}
    const progress = output(state), signature=JSON.stringify(progress);
    if (progress && signature!==shownOutput) {shownOutput=signature;void panel.webview.postMessage({type:'command-output',reviewId:target.snapshot.id,progress:[progress]});}
    const message = !state.connected ? 'Disconnected · showing the last recorded output.' : state.sessionId!==target.sessionId || state.review?.id!==target.snapshot.id ? 'Earlier step · showing its recorded command and output.' : 'Approvals and step navigation are in the Pair sidebar.';
    if(connection!==message){connection=message;void panel.webview.postMessage({type:'connection',text:message});}
  }
  context.subscriptions.push({dispose(){panel?.dispose();}});
  return {open,sync,openSource,getState:()=>({open:!!panel,reviewId:target?.snapshot.id,index:target?.index})};
}
module.exports={renderCommandCenter,createCommandCenter};

function renderTerminal(snapshot,index,root,initial,connected,assets,nonce){
  const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${assets.csp};"><link rel="stylesheet" href="${assets['vendor/xterm.css']}"><style>
  ${commandCenterCss}
  </style></head><body>${commandHeader(snapshot,index)}${commandOverview(snapshot,index,root,true)}<section class="terminal-box" aria-label="Command output"><div class="toolbar"><strong id="output-status">Output · ${esc(initial.status)}</strong><div class="buttons"><button id="follow" aria-pressed="true">Auto-scroll on</button><button id="stop" hidden disabled>Stop command</button></div></div><div id="terminal" aria-label="Command terminal"></div><div class="terminal-footer"><div id="input-status">Command output</div><div id="output-note" class="muted"></div></div></section><div id="connection">${connected?'Review and approve steps in the Pair sidebar.':'Disconnected · last recorded output.'}</div>
  ${['vendor/xterm.js','vendor/addon-fit.js','vendor/highlight.js','vendor/powershell.js'].map(file=>`<script nonce="${nonce}" src="${assets[file]}"></script>`).join('')}<script nonce="${nonce}">const commandIdentity=${json({reviewId:snapshot.id,index})};const initialOutput=${json(initial)};</script><script nonce="${nonce}" src="${assets['terminal-client.js']}"></script></body></html>`;
}
