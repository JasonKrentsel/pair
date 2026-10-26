'use strict';
const VERSION = require('./package.json').version;
const crypto = require('node:crypto');
const { identity } = require('./client.cjs');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Deliberately small Markdown subset. Source HTML, images, command links and
// remote content remain inert; native MarkdownString handles editor threads.
function inlineMarkdown(text) {
  return escape(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}
function markdown(text) {
  const lines = String(text ?? '').split(/\r?\n/), output = [];
  let code, list = false;
  const endList = () => { if (list) { output.push('</ul>'); list = false; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      endList(); if (code) { output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = undefined; } else code = []; continue;
    }
    if (code) { code.push(line); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { if (!list) { output.push('<ul>'); list = true; } output.push(`<li>${inlineMarkdown(bullet[1])}</li>`); continue; }
    endList(); if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    output.push(heading ? `<h3>${inlineMarkdown(heading[1])}</h3>` : `<p>${inlineMarkdown(line)}</p>`);
  }
  endList(); if (code) output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return output.join('');
}
const humanStatus = value => ({ draft: 'Draft · not sent', submitted: 'Submitted · waiting for Pi', 'revision-ready': 'Revision ready', answered: 'Answered', addressed: 'Addressed', outdated: 'Older code · inspect anchor' }[value] || value);
const scopedLabel = thread => `${thread.label} · ${thread.side} ${thread.startLine}–${thread.endLine}`;

function sidebarFeedback({ drafts, threads, supported, connected, pending, busy, submission, part = 'all' }) {
  if (!supported) return '';
  const ready = drafts.filter(draft => !draft.outdated).length;
  const controls = `<section class="feedback-summary"><h3>Section feedback${drafts.length ? ` · ${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'}` : threads.length ? ` · ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}` : ''}</h3>
    <div class="actions"><button class="secondary" data-action="desk">Review Desk</button>
    <button data-action="send-feedback" ${connected && !busy && (submission || pending && ready) ? '' : 'disabled'}>${submission ? 'Retry feedback' : `Send ${ready || ''} ${ready === 1 ? 'comment' : 'comments'}`}</button></div>
    <p class="muted">Sending feedback pauses approval.</p></section>`;
  const list = `<section class="feedback-drafts">${drafts.slice(0, 3).map(draft => `<div class="draft"><span class="muted">${escape(draft.intent === 'ask' ? 'Ask' : 'Request change')} · ${escape(draft.label)}</span><p>${escape(draft.text)}</p>${draft.outdated ? '<span class="warning">Older proposal · re-anchor before sending</span>' : ''}</div>`).join('')}
    ${!drafts.length ? `<p class="muted">${pending ? 'Select lines in the diff, then right-click → Pair: Ask About Selected Lines or Request Change to Selected Lines.' : 'This change is complete. Section feedback is available on the next pending proposal.'}</p>` : ''}</section>`;
  return part === 'controls' ? controls : part === 'drafts' ? list : controls + list;
}

function renderDesk({ drafts = [], threads = [], selectedId, review, feedback, connected, trusted, busy, submission, errorMessage = '', scrollTarget }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const items = [...drafts, ...threads];
  const item = items.find(value => value.id === selectedId) || items[0];
  const selected = item?.id;
  const revision = feedback?.revision;
  const clientIdentity = JSON.stringify({ scopeId: feedback?.scopeId, revision, reviewIdentity: review ? identity(review) : undefined }).replace(/</g, '\\u003c');
  const canSend = connected && trusted && !busy && (submission || review?.pending && drafts.some(value => !value.outdated));
  const readyCount = drafts.filter(draft => !draft.outdated).length;
  const archived = item && feedback?.reviews.find(value => value.id === item.reviewId);
  const latest = item?.latestReviewId && feedback?.reviews.find(value => value.id === item.latestReviewId);
  const perFile = archived?.changes[item?.changeIndex];
  const groups = [
    ['Drafts', items.filter(value => value.status === 'draft' && !value.outdated)],
    ['Changed since feedback', items.filter(value => value.status === 'revision-ready')],
    ['Waiting for Pi', items.filter(value => value.status === 'submitted')],
    ['Answered', items.filter(value => value.status === 'answered')],
    ['Addressed', items.filter(value => value.status === 'addressed')],
    ['Older anchors', items.filter(value => value.outdated || value.status === 'outdated')],
  ];
  const navigation = groups.filter(([, values]) => values.length).map(([label, values]) => `<h3>${label} · ${values.length}</h3>${values.map(value => `<button class="thread-row${value.id === selected ? ' selected' : ''}" data-action="select" data-id="${escape(value.id)}" aria-pressed="${value.id === selected}"><span class="muted">${escape(scopedLabel(value))}</span><span>${escape(value.intent === 'ask' ? 'Question' : 'Requested change')}</span><span class="thread-preview">${escape(value.text)}</span><span class="muted">${escape(value.outdated ? 'Older proposal · draft retained' : humanStatus(value.status))}</span></button>`).join('')}`).join('');
  const overview = review ? `<h2>${review.pending ? 'Ready for your review' : 'Latest change · ' + escape(review.status)}</h2>
    <div class="explanation">${markdown(review.why)}</div>
    <p>${review.pending ? 'Open a file below, select the lines you want to discuss, then right-click and choose Pair: Ask About Selected Lines or Pair: Request Change to Selected Lines.' : 'This change is no longer awaiting permission. Its snapshots are available below. Add section feedback during the next pending proposal, before approving it.'}</p>
    <h3>${review.changes.some(change => change.command !== undefined) ? 'Reviewed actions' : 'Files in this change'}</h3>
    ${review.changes.map((change, index) => `<button class="thread-row" data-action="open-file" data-index="${index}"><strong>${escape(change.command !== undefined ? change.kind + ' command' : change.label)}</strong><span class="muted">${escape(change.kind)}${change.command === undefined ? ' · +' + (change.added || 0) + ' −' + (change.removed || 0) : ''} · Open ${change.command !== undefined ? 'command' : 'diff'}</span></button>${change.why ? markdown(change.why) : ''}`).join('')}
    <p class="muted">No section comments yet. Drafts will appear here as you add them; nothing is sent until you choose Send feedback.</p>`
    : `<h2>${connected ? 'Connected · waiting for a proposal' : 'Connect to your Pi conversation'}</h2><p>${connected ? 'The next Pair change will appear here automatically, with its explanation and files. You do not need to add a comment first.' : 'Open the same project folder in Pi and VS Code, then run /pair code in Pi. Reconnect here if you have just reloaded Pi.'}</p>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
    .thread-row .thread-preview{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.content pre{tab-size:2}.layout.overview{display:block;min-height:0}.layout.overview nav{display:none}.connection{padding:12px 22px;background:var(--vscode-textCodeBlock-background)}.layout{min-height:calc(100vh - 145px)}
    body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.5}*{box-sizing:border-box}header{padding:16px 22px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}h1{font-size:1.2em;font-weight:600;margin:0}h2{font-size:1.1em;margin:0 0 12px}h3{font-size:1em;margin:12px 0 6px;font-weight:600}p{margin:6px 0 12px;overflow-wrap:anywhere}.muted{color:var(--vscode-descriptionForeground);font-size:.92em}.warning{color:var(--vscode-editorWarning-foreground)}.layout{display:grid;grid-template-columns:minmax(220px,30%) minmax(0,1fr)}nav{background:var(--vscode-sideBar-background);padding:16px 12px;min-width:0;border-right:1px solid var(--vscode-panel-border)}.content{padding:22px;min-width:0}button{font:inherit;border:1px solid transparent;border-radius:3px;padding:6px 10px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{filter:brightness(1.1)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.thread-row{display:block;width:100%;text-align:left;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);margin:8px 0;padding:12px;white-space:normal;overflow-wrap:anywhere}.thread-row.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.thread-row.selected .muted{color:inherit;opacity:.85}.thread-row span{display:block}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pill{font-size:.9em;color:var(--vscode-descriptionForeground)}.thread-body{padding:14px 16px;border:1px solid var(--vscode-panel-border);margin:16px 0}.excerpt{background:var(--vscode-textCodeBlock-background);padding:12px;border-left:2px solid var(--vscode-textLink-foreground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);margin:8px 0}code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background)}.excerpt .line{display:grid;grid-template-columns:38px minmax(0,1fr)}.number{color:var(--vscode-editorLineNumber-foreground);user-select:none}footer{position:sticky;bottom:0;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-panel-border);padding:12px 22px;display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap}.empty{padding:25px 0}.explanation{border-left:2px solid var(--vscode-textLink-foreground);padding:0 12px;margin:12px 0 20px}.sensitive{white-space:pre-wrap}@media(max-width:640px){.layout{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--vscode-panel-border)}.content{padding:16px}header,footer{padding:12px 16px}}
    </style></head><body><header><div><h1>Review Desk</h1><div class="muted">${escape(review?.title || 'Pair section feedback')}</div></div><div class="actions"><button class="secondary" data-action="open-current" ${review ? '' : 'disabled'}>Open current ${review?.changes.some(change => change.command !== undefined) ? 'action' : 'diff'}</button><button data-action="send" ${canSend ? '' : 'disabled'}>${submission ? 'Retry feedback submission' : (readyCount ? `Send ${readyCount} draft ${readyCount === 1 ? 'comment' : 'comments'}` : 'Send feedback')}</button></div></header>
    ${!connected || errorMessage ? `<section class="connection" role="status"><p>${escape(errorMessage || 'Not connected to Pi. Local drafts are retained.')}</p><div class="actions"><button data-action="refresh">Reconnect</button><button class="secondary" data-action="session">Select Pi session</button></div></section>` : ''}
    <div class="layout${items.length ? '' : ' overview'}"><nav aria-label="Review feedback"><h2>Feedback</h2><p class="muted">${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'} · ${threads.length} submitted</p>
      ${items.length ? navigation : '<p class="empty muted">Select lines in a Pair diff to ask a question or request a change. Draft comments stay here until you send them.</p>'}</nav>
    <main class="content">${item ? `<h2>${escape(item.label)}</h2><div class="actions"><span class="pill">${escape(humanStatus(item.outdated ? 'outdated' : item.status))}</span><button class="secondary" data-action="open" data-id="${escape(item.id)}">Open anchored diff</button>${latest ? `<button class="secondary" data-action="compare" data-id="${escape(item.id)}">Changes since feedback</button>` : ''}</div>
      ${perFile?.why ? `<div class="explanation">${markdown(perFile.why)}</div>` : ''}<div class="excerpt"><div class="muted">Exact ${escape(item.side)} snapshot · lines ${item.startLine}–${item.endLine}</div><pre>${escape(item.excerpt || '').split('\n').map((line, i) => `<span class="line"><span class="number">${item.startLine + i}</span><span>${line || ' '}</span></span>`).join('')}</pre></div>
      <section class="thread-body"><h3>Your ${item.intent === 'ask' ? 'question' : 'requested change'}</h3>${markdown(item.text)}
      ${item.reply ? `<h3>Pi’s reply</h3>${markdown(item.reply)}` : item.status !== 'draft' ? '<p class="muted">Pi receives this feedback in the existing conversation. Any recorded reply appears here.</p>' : '<p class="muted">Draft · not sent to Pi.</p>'}</section>
      <div class="actions">${item.status === 'draft' ? `<button class="secondary" data-action="edit" data-id="${escape(item.id)}">Edit draft</button><button class="secondary" data-action="remove" data-id="${escape(item.id)}">Remove draft</button>` : `<button class="secondary" data-action="address" data-id="${escape(item.id)}" ${connected && trusted && !busy ? '' : 'disabled'}>${item.status === 'addressed' ? 'Reopen feedback' : 'Mark addressed'}</button><button class="secondary" data-action="followup" data-id="${escape(item.id)}">Follow up on current code</button>`}</div>
      <p class="muted">Marking feedback addressed does not approve execution. Unrelated reviewed drafts remain available.</p>` : overview}</main></div>
    <footer><span class="muted">${connected ? 'Reviewing locally · drafts and navigation use no model calls' : 'Disconnected · local drafts retained'}</span><span class="muted">Pair ${escape(VERSION)} · ${connected ? 'Connected' : 'Disconnected'}</span></footer>
    <script nonce="${nonce}">const api=acquireVsCodeApi();const identity=${clientIdentity};const previous=api.getState()||{};document.querySelectorAll('button[data-action]').forEach(button=>button.addEventListener('click',()=>{api.setState({...previous,scrollY:window.scrollY});api.postMessage({action:button.dataset.action,id:button.dataset.id,index:button.dataset.index,...identity});}));window.addEventListener('scroll',()=>api.setState({...previous,scrollY:window.scrollY}),{passive:true});window.scrollTo(0,${scrollTarget === 'top' ? 0 : 'previous.scrollY||0'});</script></body></html>`;
}

module.exports = { escape, markdown, sidebarFeedback, renderDesk, scopedLabel, humanStatus };
