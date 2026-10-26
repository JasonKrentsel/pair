'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { escape, markdown } = require('./markdown.cjs');
const { decisionIdentity } = require('./client.cjs');
const { commandTitle } = require('./review-panel.cjs');

function conversationMarkdown(text) {
  const languages = [];
  let inside = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fence = line.match(/^\s*```([\w+-]*)/);
    if (!fence) continue;
    if (!inside) languages.push(fence[1]);
    inside = !inside;
  }
  let index = 0;
  const aliases = { ts:'typescript', js:'javascript', sh:'bash', shell:'bash', ps1:'powershell', pwsh:'powershell', jsonc:'json' };
  return markdown(text).replace(/<pre><code>/g, () => {
    const name = languages[index++] || '';
    const language = aliases[name] || name;
    return `<pre tabindex="0"><code${language ? ` class="language-${escape(language)}"` : ''}>`;
  });
}

function targetIdentity(conversation) {
  return conversation?.identity || (conversation && {reviewId:conversation.reviewId,revision:conversation.revision,fingerprint:conversation.fingerprint,gate:conversation.gate});
}

function currentConversation({ review, conversation }) {
  const identity = targetIdentity(conversation);
  return !!review && !!conversation?.id && !!identity && review.id === identity.reviewId
    && review.revision === identity.revision && review.fingerprint === identity.fingerprint
    && (review.gate ?? 1) === (identity.gate ?? 1) && review.pending;
}

function actionConversationUpdate(options) {
  const { conversation, connected = false, trusted = true, busy = false, errorMessage = '' } = options;
  const current = currentConversation(options);
  const running = conversation?.status === 'running';
  const candidate = conversation?.candidate;
  const locked = ['closed','stale'].includes(conversation?.status) || !current;
  const warning = !connected ? 'Reconnect to Pi to continue this conversation.'
    : !trusted ? 'Trust this workspace before sending a message or using a revision.'
    : locked ? 'The step changed or finished. Return to the step to review its current version.'
    : errorMessage || conversation?.error || '';
  const ready = connected && trusted && !locked && !busy;
  return {
    type:'action-conversation', id:conversation?.id || '',
    messages:(conversation?.messages || []).map((message,index) => ({
      key:String(message.id ?? index), role:message.role === 'user' ? 'user' : 'assistant',
      html:running && message.role === 'assistant' && !String(message.text ?? '').trim() && index === conversation.messages.length-1 ? '<p class="quiet">Preparing a response…</p>' : conversationMarkdown(message.text ?? ''),
    })),
    status:locked ? 'Earlier conversation' : running ? 'Pi is responding…' : candidate ? 'Revision ready to inspect' : conversation?.status === 'error' ? 'Response stopped' : 'Step still awaits approval',
    warning, running, canSend:ready && !running, canStop:ready && running,
    candidateId:candidate?.id,
    candidateHtml:candidate ? `<div class="candidate-heading"><strong>Suggested revision</strong>${Number.isFinite(candidate.added) && Number.isFinite(candidate.removed) ? `<span class="delta"><span class="added">+${candidate.added}</span> <span class="removed">−${candidate.removed}</span></span>` : ''}</div><div class="prose">${conversationMarkdown(candidate.summary || 'Review the suggested update to this action.')}</div><div class="candidate-actions"><button class="secondary" data-action="conversation-preview" ${ready ? '' : 'disabled'}>Inspect diff</button><button class="primary" data-action="conversation-adopt" ${ready && !running ? '' : 'disabled'}>Use revision</button><button class="text-button" data-action="conversation-discard" ${ready && !running ? '' : 'disabled'}>Discard</button></div><p class="candidate-note">Updates this proposed action. The step still needs approval to run.</p>` : '',
  };
}

function client() {
  const api = acquireVsCodeApi();
  const initial = JSON.parse(document.getElementById('conversation-state').textContent);
  const identity = initial.identity;
  const conversationId = initial.update.id;
  const area = document.getElementById('transcript');
  const list = document.getElementById('messages');
  const textarea = document.getElementById('message');
  const form = document.getElementById('composer');
  const submit = document.getElementById('send');
  const stop = document.getElementById('stop');
  const warning = document.getElementById('warning');
  const status = document.getElementById('conversation-status');
  const candidate = document.getElementById('candidate');
  const latest = document.getElementById('latest');
  const modeHelp = document.getElementById('mode-help');
  const empty = document.getElementById('empty');
  let state = initial.update, sending = false, pendingRequest, sentText, candidateHtml, following = true;
  const saved = api.getState()?.conversationDrafts?.[conversationId];
  const mode = () => document.querySelector('input[name="mode"]:checked')?.value || 'ask';
  if (saved) {
    textarea.value = saved.draft || '';
    if(!initial.mode) {
      const option=document.querySelector('input[name="mode"][value="'+(saved.mode==='adjust'?'adjust':'ask')+'"]');
      if(option)option.checked=true;
    }
    following = saved.following !== false;
  }
  function save() {
    const prior = api.getState() || {};
    const drafts = { ...(prior.conversationDrafts || {}) };
    drafts[conversationId] = {draft:textarea.value,mode:mode(),scroll:area.scrollTop,following};
    // Keep local drafts bounded and scoped; a new review gets a different ID.
    const keys = Object.keys(drafts);
    for (const key of keys.slice(0,Math.max(0,keys.length-16))) delete drafts[key];
    api.setState({...prior,conversationDrafts:drafts});
  }
  function controls() {
    submit.textContent = sending ? 'Sending…' : mode() === 'adjust' ? 'Request revision' : 'Ask';
    submit.disabled = !state.canSend || sending;
    stop.hidden = !state.running;
    stop.disabled = !state.canStop;
    modeHelp.textContent = mode() === 'adjust' ? 'Propose a focused revision; nothing runs.' : 'Get an explanation without changing the step.';
    textarea.placeholder = initial.command
      ? mode() === 'adjust' ? 'Describe a focused change to this command…' : 'What does this command do…'
      : mode() === 'adjust' ? 'Keep the protocol; simplify this function…' : 'Why does this function use this approach…';
  }
  function highlight(root) {
    if (!globalThis.hljs) return;
    root.querySelectorAll('pre code').forEach(code => {
      try {
        const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
        if (language && !hljs.getLanguage(language)) return;
        hljs.highlightElement(code);
      } catch { /* Plain code remains readable if its grammar is unavailable. */ }
    });
  }
  function render(next) {
    if (next.id !== conversationId) return;
    state = next;
    const userMessages = state.messages.filter(message => message.role === 'user');
    if (sending && (state.running || userMessages.length > initial.userCount)) {
      sending = false; pendingRequest = undefined;
      // Clear only the exact submitted draft. Typing the next message is safe.
      if (textarea.value === sentText) textarea.value = '';
      initial.userCount = userMessages.length;
      save();
    }
    const existing = new Map([...list.children].map(node => [node.dataset.message,node]));
    for (const message of state.messages) {
      let node = existing.get(message.key);
      if (!node) {
        node = document.createElement('article');
        node.dataset.message = message.key;
        list.appendChild(node);
      }
      existing.delete(message.key);
      const html = `<div class="speaker">${message.role === 'user' ? 'You' : 'Pi'}</div><div class="prose">${message.html}</div>`;
      if (node.dataset.html !== html) {
        node.className = `message ${message.role}`;
        node.innerHTML = html;
        node.dataset.html = html;
        highlight(node);
      }
    }
    for (const node of existing.values()) node.remove();
    empty.hidden = state.messages.length > 0;
    status.textContent = state.status;
    warning.textContent = state.warning;
    warning.hidden = !state.warning;
    if (candidateHtml !== state.candidateHtml) {
      candidate.innerHTML = state.candidateHtml;
      candidate.hidden = !state.candidateHtml;
      candidateHtml = state.candidateHtml;
      highlight(candidate);
    }
    controls();
    if (following) area.scrollTop = area.scrollHeight;
    latest.hidden = following || !state.messages.length;
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    save();
    api.postMessage({action:button.dataset.action,conversationId,identity,index:initial.index,candidateId:state.candidateId});
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!state.canSend || sending) return;
    const text = textarea.value.trim();
    if (!text) {
      warning.textContent = 'Enter a question or describe the revision.';
      warning.hidden = false;
      textarea.focus();
      return;
    }
    if (text.length > 3000) return;
    if (!pendingRequest || pendingRequest.text !== text || pendingRequest.mode !== mode()) pendingRequest = {text,mode:mode(),id:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`};
    sentText = textarea.value;
    sending = true;
    following = true;
    save();controls();
    status.textContent = 'Sending your message…';
    api.postMessage({action:'conversation-send',conversationId,identity,index:initial.index,mode:mode(),text,requestId:pendingRequest.id});
  });
  textarea.addEventListener('input', () => { save(); });
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => {controls();save();textarea.focus();}));
  area.addEventListener('scroll', () => {
    following = area.scrollHeight - area.scrollTop - area.clientHeight < 40;
    latest.hidden = following || !state.messages.length;
    save();
  }, {passive:true});
  latest.addEventListener('click', () => { following = true; area.scrollTop = area.scrollHeight; latest.hidden = true; save(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'action-conversation') render(message);
    if (message?.type === 'action-conversation-error' && (!message.id || message.id === conversationId)) {
      sending = false;
      warning.textContent = message.text || 'The message was not sent. Try again.';
      warning.hidden = false;
      controls();
    }
  });
  render(state);
  if (saved && !following) area.scrollTop = saved.scroll || 0;
  controls();
  api.postMessage({action:'conversation-ready',conversationId});
}

function renderActionConversation(options) {
  const { review, index = 0, conversation, assets } = options;
  const scope = options.scope || conversation?.scope || {startLine:conversation?.startLine,endLine:conversation?.endLine};
  const change = review?.changes[index] || {};
  const command = typeof change.command === 'string';
  const label = command ? commandTitle(change.command) || `${change.kind || 'Command'} action` : change.label || 'Selected action';
  const filename = command ? label : path.posix.basename(label.replace(/\\/g,'/'));
  const selection = Number.isInteger(scope.startLine) ? `Lines ${scope.startLine}${scope.endLine && scope.endLine !== scope.startLine ? '–'+scope.endLine : ''}` : 'Whole action';
  const nonce = crypto.randomBytes(16).toString('hex');
  const update = actionConversationUpdate(options);
  const identity = targetIdentity(conversation) || (review && decisionIdentity(review));
  const initial = JSON.stringify({identity,index,command,update,mode:options.mode || null,userCount:update.messages.filter(message=>message.role==='user').length}).replace(/</g,'\\u003c');
  const initialMode = options.mode === 'adjust' ? 'adjust' : 'ask';
  const sourceText = command ? change.command : change.after;
  const scopeText = typeof scope.excerpt === 'string' ? scope.excerpt : Number.isInteger(scope.startLine) && typeof sourceText === 'string' && currentConversation(options) ? sourceText.split(/\r\n|\r|\n/).slice(scope.startLine-1,scope.endLine || scope.startLine).join('\n') : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
  :root{color-scheme:light dark}*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size)/1.55 var(--vscode-font-family);overflow:hidden}button,textarea,input{font:inherit}button{cursor:pointer;border:1px solid transparent;border-radius:3px;color:inherit;min-height:28px}button:disabled{opacity:.5;cursor:default}button:focus-visible,textarea:focus-visible,summary:focus-visible,pre:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}button:hover:not(:disabled){filter:brightness(1.12)}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  header{padding:10px 16px 12px;border-bottom:1px solid var(--vscode-panel-border);flex:none}.back{background:none;color:var(--vscode-textLink-foreground);padding:0 2px;font-size:12px}.heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:8px}h1{font-size:15px;line-height:1.4;margin:0;font-weight:600;overflow-wrap:anywhere;min-width:0}.scope-label{font-size:12px;color:var(--vscode-descriptionForeground);margin:4px 0 0}.scope-label .scope-range{color:var(--vscode-foreground)}.context{margin-top:8px;font-size:12px;max-height:25vh;overflow:auto}.context summary{cursor:pointer;color:var(--vscode-descriptionForeground)}.context pre{margin:7px 0 0;white-space:pre;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:8px;font:12px/1.5 var(--vscode-editor-font-family)}
  #transcript{min-height:0;flex:1;overflow-y:auto;overflow-x:hidden;padding:12px 16px 18px;overscroll-behavior:contain;scrollbar-gutter:stable}.message{margin:0 0 20px;overflow-wrap:anywhere}.message.user{padding:9px 11px;background:var(--vscode-chat-requestBackground,var(--vscode-textCodeBlock-background));border-radius:4px}.speaker{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:5px}.prose p{margin:0 0 8px}.prose p:last-child{margin-bottom:0}.prose ul{padding-left:19px;margin:8px 0}.prose h3{font-size:1em;line-height:1.4;margin:12px 0 6px}.prose code{font-family:var(--vscode-editor-font-family);font-size:.95em;color:var(--vscode-textPreformat-foreground);background:var(--vscode-textCodeBlock-background);border-radius:2px;padding:1px 3px}.prose pre{max-width:100%;margin:10px 0;overflow:auto;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border);border-radius:3px;padding:10px;line-height:1.55;tab-size:2}.prose pre code{padding:0;background:none;color:var(--vscode-editor-foreground);display:block;font-size:12px}.empty{margin-top:10px;color:var(--vscode-descriptionForeground)}.empty strong{display:block;color:var(--vscode-foreground);font-weight:500;margin-bottom:8px}.empty p{margin:0 0 12px}.quiet{font-size:12px;color:var(--vscode-descriptionForeground)}
  .candidate{margin:10px 0 2px;border-top:2px solid var(--vscode-textLink-foreground);padding-top:12px}.candidate-heading{display:flex;gap:10px;justify-content:space-between;margin-bottom:7px}.candidate-heading strong{font-weight:600}.delta{white-space:nowrap;font-size:12px;font-variant-numeric:tabular-nums}.added{color:var(--vscode-gitDecoration-addedResourceForeground)}.removed{color:var(--vscode-gitDecoration-deletedResourceForeground)}.candidate-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:6px 10px}.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:6px 10px}.text-button{background:none;color:var(--vscode-textLink-foreground);padding:4px 3px}.candidate-note{font-size:11px;color:var(--vscode-descriptionForeground);margin:8px 0 0}
  .composer-area{flex:none;padding:9px 16px 12px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.status-line{display:flex;gap:8px;justify-content:space-between;align-items:center;min-height:24px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:7px}.status-line span{min-width:0;overflow-wrap:anywhere}.status-line button{font-size:11px;min-height:24px;padding:2px 6px}.warning{color:var(--vscode-editorWarning-foreground);font-size:12px;margin:0 0 8px;max-height:7em;overflow:auto;overflow-wrap:anywhere}.modes{display:flex;gap:4px;margin:0 0 8px;padding:0;border:0}.modes label{display:flex;align-items:center;gap:5px;min-height:28px;padding:2px 8px;cursor:pointer;border-radius:3px;font-size:12px}.modes label:has(input:checked){background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground)}.modes input{margin:0;accent-color:var(--vscode-focusBorder)}#message-label{display:block;font-size:12px;font-weight:500;margin-bottom:5px}textarea{display:block;width:100%;resize:vertical;min-height:72px;max-height:25vh;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;line-height:1.45}textarea::placeholder{color:var(--vscode-input-placeholderForeground)}.send-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.send-row .shortcut{font-size:10px;color:var(--vscode-descriptionForeground)}#mode-help{font-size:11px;color:var(--vscode-descriptionForeground);margin:6px 0 0}.latest{position:sticky;bottom:0;display:block;margin:4px auto 0;padding:4px 9px;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border)}
  .hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--vscode-symbolIcon-keywordForeground,#c586c0)}.hljs-string,.hljs-regexp,.hljs-template-variable{color:var(--vscode-debugTokenExpression-string,#ce9178)}.hljs-number{color:var(--vscode-debugTokenExpression-number,#b5cea8)}.hljs-title,.hljs-function{color:var(--vscode-symbolIcon-functionForeground,#dcdcaa)}.hljs-comment,.hljs-quote{color:var(--vscode-descriptionForeground);font-style:italic}.hljs-variable,.hljs-params,.hljs-attr{color:var(--vscode-symbolIcon-variableForeground,#9cdcfe)}.hljs-built_in,.hljs-type{color:var(--vscode-symbolIcon-classForeground,#4ec9b0)}@media(max-width:280px){header,#transcript,.composer-area{padding-inline:10px}.send-row .shortcut{max-width:90px}.candidate-actions button{flex:1}h1{font-size:14px}}@media(forced-colors:active){button,textarea,.message.user{border:1px solid CanvasText}}
  </style></head><body><header><button class="back" data-action="conversation-back">‹ Back to step</button><div class="heading"><h1 title="${escape(label)}">${escape(filename)}</h1><button class="text-button" data-action="conversation-open-action" aria-label="Open this action in the editor">Open</button></div><p class="scope-label">Action ${index+1} of ${review?.changes.length || 1} <span aria-hidden="true">·</span> <span class="scope-range">${escape(selection)}</span></p>${scopeText ? `<details class="context"><summary>Selected code</summary><pre tabindex="0"><code>${escape(scopeText)}</code></pre></details>` : ''}</header>
  <main id="transcript" aria-label="Conversation about this action"><div id="empty" class="empty"><strong>Ask about this part, or suggest a small change.</strong><p>Keep the diff open beside this conversation. Pi can explain the proposal or prepare a focused revision.</p><p class="quiet">The main step remains waiting for your approval.</p></div><div id="messages"></div><section id="candidate" class="candidate" aria-label="Suggested revision" hidden></section><button id="latest" class="latest" hidden>Latest response</button></main>
  <footer class="composer-area"><div class="status-line"><span id="conversation-status" role="status" aria-live="polite"></span><button id="stop" class="secondary" data-action="conversation-stop" hidden>Stop</button></div><p id="warning" class="warning" role="alert" hidden></p><form id="composer"><fieldset class="modes"><legend class="sr-only">Message purpose</legend><label><input type="radio" name="mode" value="ask" ${initialMode==='ask'?'checked':''}>Ask</label><label><input type="radio" name="mode" value="adjust" ${initialMode==='adjust'?'checked':''}>Adjust</label></fieldset><label id="message-label" for="message">Message to Pi</label><textarea id="message" name="message" rows="3" maxlength="3000" autocomplete="off" aria-describedby="mode-help" placeholder="${command ? initialMode==='adjust' ? 'Describe a focused change to this command…' : 'What does this command do…' : initialMode==='adjust' ? 'Keep the protocol; simplify this function…' : 'Why does this function use this approach…'}"></textarea><div class="send-row"><span class="shortcut">Enter sends<br>Shift+Enter adds a line</span><button id="send" class="primary" type="submit">Ask</button></div><p id="mode-help"></p></form></footer>
  <script id="conversation-state" type="application/json" nonce="${nonce}">${initial}</script>${assets?.['vendor/highlight.js'] ? `<script nonce="${nonce}" src="${escape(assets['vendor/highlight.js'])}"></script>` : ''}${assets?.['vendor/powershell.js'] ? `<script nonce="${nonce}" src="${escape(assets['vendor/powershell.js'])}"></script>` : ''}<script nonce="${nonce}">(${client.toString()})();</script></body></html>`;
}

module.exports = { renderActionConversation, actionConversationUpdate, conversationMarkdown, currentConversation };
