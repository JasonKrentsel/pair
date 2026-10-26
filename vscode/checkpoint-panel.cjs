'use strict';
const crypto = require('node:crypto');

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const scopeLabel = (scope, pendingTurn = false) => scope === 'turn' ? pendingTurn ? 'Next turn' : 'This turn' : 'This task';

function renderCheckpointPanel({ memory, sessionId, connected, trusted, busy, pending, errorMessage }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const checkpoint = memory?.checkpoint;
  const constraints = memory?.constraints || [];
  const canEdit = connected && trusted && !busy && memory !== undefined;
  const identity = JSON.stringify({ sessionId, revision: memory?.revision }).replace(/</g, '\\u003c');
  const missing = '<span class="muted">Not recorded</span>';
  const fields = [
    ['Objective', checkpoint?.objective], ['Implemented', checkpoint?.implemented],
    ['Verification · agent report', checkpoint?.verification], ['Usable now', checkpoint?.usable],
    ['Deferred', checkpoint?.deferred], ['Next decision', checkpoint?.next],
  ].map(([label, value]) => `<div class="field"><h3>${escape(label)}</h3><p>${value ? escape(value) : missing}</p></div>`).join('');
  const updated = checkpoint && Number.isFinite(Date.parse(checkpoint.updatedAt)) ? new Date(checkpoint.updatedAt).toLocaleString() : '';
  const blocker = !connected ? errorMessage || 'Connect to Pi in this workspace to see its checkpoint.'
    : !trusted ? 'Workspace Trust is required to change pinned constraints.'
    : memory === undefined ? 'This Pi session does not provide checkpoint data yet. Update Pair and reconnect.' : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
    body{padding:0 16px 16px;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.45}h2{font-size:1em;margin:18px 0 8px;font-weight:600}h3{font-size:.92em;color:var(--vscode-descriptionForeground);margin:0 0 3px;font-weight:600}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.field{margin:12px 0}.muted{color:var(--vscode-descriptionForeground);font-size:.92em}.warning{color:var(--vscode-editorWarning-foreground);margin:10px 0}.actions{position:sticky;top:0;padding:10px 0;display:flex;flex-wrap:wrap;gap:8px;background:var(--vscode-sideBar-background);z-index:1}button{border:1px solid transparent;border-radius:2px;padding:5px 9px;font:inherit;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.constraint{padding:8px 0;border-top:1px solid var(--vscode-widget-border)}.scope{display:block;color:var(--vscode-descriptionForeground);font-size:.9em;margin-top:3px}.rule{border-top:1px solid var(--vscode-widget-border);margin-top:16px;padding-top:10px}
    </style></head><body>
    <div class="actions"><button data-action="add" ${canEdit ? '' : 'disabled'}>Add constraint</button><button data-action="remove" ${canEdit && constraints.length ? '' : 'disabled'}>Remove constraint</button></div>
    ${blocker ? `<p class="warning" role="status">${escape(blocker)}</p>` : ''}
    <p class="muted">${checkpoint ? `Agent report · revision ${checkpoint.revision}${updated ? ` · ${escape(updated)}` : ''}` : 'No checkpoint recorded yet. The agent updates this at useful milestones.'}</p>
    ${checkpoint?.stale ? '<p class="warning" role="status">Work changed after this checkpoint. Verification needs a fresh report.</p>' : ''}
    ${fields}
    <h2>Pinned human constraints</h2>
    ${constraints.length ? constraints.map(constraint => `<div class="constraint"><p>${escape(constraint.text)}</p><span class="scope">${scopeLabel(constraint.scope, constraint.pendingTurn)}</span></div>`).join('') : '<p class="muted">None pinned. Instructions in chat still apply.</p>'}
    <p class="muted rule">This task: until you remove it or start new Pair work.<br>This turn: until the next human chat message.<br>Next turn: starts with your next message, then expires on the following message.</p>
    <p class="muted rule">${pending ? 'Changing constraints cancels the pending review. ' : 'Constraint changes cancel any pending review. '}Ask Pi to continue when ready. Constraints guide the agent; they grant no permission to execute.</p>
    <script nonce="${nonce}">const api=acquireVsCodeApi();const identity=${identity};document.querySelectorAll('button[data-action]').forEach(button=>button.addEventListener('click',()=>api.postMessage({action:button.dataset.action,...identity})));</script>
    </body></html>`;
}

module.exports = { renderCheckpointPanel, scopeLabel };
