'use strict';
const VERSION = require('./package.json').version;
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalRoot, containedFile, discoverSessions, request, validReview, validMemory, identity, sameReview, decisionIdentity, sameDecision, associatedLanguage } = require('./client.cjs');
const { renderCheckpointPanel, scopeLabel } = require('./checkpoint-panel.cjs');
const { validFeedback } = require('./feedback-model.cjs');
const { markdown } = require('./feedback-ui.cjs');
const { validProgress } = require('./command-view.cjs');
const { createCommandCenter } = require('./command-center.cjs');
const { createFeedbackController } = require('./feedback-controller.cjs');

const SCHEME = 'pair-review';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function activate(context) {
  const changesChanged = new vscode.EventEmitter();
  const documents = new Map();
  let selected;
  let sessions = [];
  let review;
  let memory;
  let feedback;
  let progress = [];
  let terminal;
  let commandCenter;
  let feedbackController;
  let connected = false;
  let busy = false;
  let memoryBusy = false;
  let errorMessage = '';
  let etag;
  let refreshPromise;
  let disposed = false;
  let reviewView;
  let checkpointView;
  let displayedCheckpoint;
  let selectedIndex = 0;
  let autoOpened;
  let lastDiscovery = 0;
  let displayedState;
  let latestFocusTime = 0;
  const handledFocus = new Set();

  const roots = () => (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  const matchesWorkspace = session => !!session && roots().some(root => canonicalRoot(root) === canonicalRoot(session.root));
  const alteredSnapshots = () => !selected || !review ? [] : vscode.workspace.textDocuments.filter(document => {
    if (document.uri.scheme !== SCHEME || document.uri.authority !== selected.sessionId) return false;
    const query = new URLSearchParams(document.uri.query);
    if (!sameReview(review, { reviewId: query.get('reviewId'), revision: Number(query.get('revision')), fingerprint: query.get('fingerprint') })) return false;
    const original = documents.get(document.uri.toString());
    return original !== undefined && document.getText() !== original;
  });
  const dirtyFiles = () => !selected || !review ? [] : review.changes.filter(change => change.before !== undefined || change.after !== undefined).flatMap(change => {
    const file = containedFile(selected.root, change.label);
    if (!file) return [change.label];
    return vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && document.isDirty && canonicalRoot(document.uri.fsPath) === canonicalRoot(file)) ? [change.label] : [];
  });
  const canDecide = () => connected && !busy && !memoryBusy && matchesWorkspace(selected) && review?.pending && vscode.workspace.isTrusted;
  const canApprove = () => canDecide() && !dirtyFiles().length && !alteredSnapshots().length && !feedbackController?.blocksApproval();
  const canEditMemory = () => connected && !busy && !memoryBusy && matchesWorkspace(selected) && memory !== undefined && vscode.workspace.isTrusted;
  const liveState = () => ({ sessionId: selected?.sessionId, root: selected?.root, connected, review, memory, feedback, progress, terminal, connectionError: errorMessage });
  const state = () => structuredClone(liveState());
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
  status.command = 'pair.review';
  context.subscriptions.push(status, changesChanged);

  function update() {
    if (disposed) return;
    feedbackController?.sync();
    commandCenter?.sync();
    updateCheckpoint();
    const signature = JSON.stringify([selected?.sessionId, connected, busy, memoryBusy, errorMessage, review?.id, review?.revision, review?.fingerprint, review?.gate, review?.status, review?.pending, sessions.length, vscode.workspace.isTrusted, dirtyFiles(), alteredSnapshots().length, feedbackController?.signature()]);
    if (signature === displayedState) return;
    displayedState = signature;

    void vscode.commands.executeCommand('setContext', 'pair.canDecide', !!canDecide()).then(undefined, () => {});
    void vscode.commands.executeCommand('setContext', 'pair.canApprove', !!canApprove()).then(undefined, () => {});
    changesChanged.fire();
    tree.description = connected && review ? review.status : selected ? 'Disconnected' : 'Not connected';
    status.text = connected ? review?.pending ? '$(git-pull-request) Pair: review' : '$(check) Pair' : '$(debug-disconnect) Pair';
    status.tooltip = connected ? `Pair · ${selected.root}\n${review?.title || 'Waiting for a proposal'}` : errorMessage || 'Open Pair to connect to a Pi session in this project.';
    if (roots().length && (selected || sessions.length)) status.show(); else status.hide();
    if (reviewView) reviewView.webview.html = renderPanel();
  }

  function checkpointOptions() {
    return { memory, sessionId: selected?.sessionId, connected, trusted: vscode.workspace.isTrusted,
      busy: busy || memoryBusy, pending: !!review?.pending, errorMessage };
  }

  function updateCheckpoint() {
    const signature = JSON.stringify([selected?.sessionId, connected, busy, memoryBusy, errorMessage, memory, review?.pending, vscode.workspace.isTrusted]);
    if (signature === displayedCheckpoint) return;
    displayedCheckpoint = signature;
    void vscode.commands.executeCommand('setContext', 'pair.canEditConstraints', !!canEditMemory()).then(undefined, () => {});
    void vscode.commands.executeCommand('setContext', 'pair.hasConstraints', !!memory?.constraints.length).then(undefined, () => {});
    if (checkpointView) checkpointView.webview.html = renderCheckpointPanel(checkpointOptions());
  }

  function renderPanel() {
    const nonce = crypto.randomBytes(16).toString('hex');
    const currentIdentity = review ? JSON.stringify(decisionIdentity(review)).replace(/</g, '\\u003c') : 'null';
    const count = review?.changes.length || 0;
    const disabled = canDecide() ? '' : 'disabled';
    const approveDisabled = canApprove() ? '' : 'disabled';
    const dirty = dirtyFiles();
    const blocker = !vscode.workspace.isTrusted ? 'Trust this workspace to respond to a proposal.'
      : alteredSnapshots().length ? 'A review snapshot was modified. Close its diff and reopen the Pair review before approving.'
      : dirty.length ? `Save or discard unsaved changes in ${dirty.join(', ')} before approving.`
      : feedbackController?.blocksApproval() ? 'Send or remove your draft feedback before approving this step.'
      : !connected ? errorMessage || 'Start Pi with Pair in this folder. Matching sessions appear here automatically.' : '';
    const actionLabel = 'Approve step';
    const running = /^Applying /.test(review?.status || '');
    const actions = review?.changes.map((change, index) => {
      const command = change.command !== undefined;
      const label = command ? 'Open command & output' : change.label;
      return `<li class="step-action"><div class="action-heading"><span class="action-number">${index + 1}</span><div><div class="muted">${escape(change.kind)}${change.interactive ? ' · Interactive' : ''}${command ? '' : ' · +' + (change.added || 0) + ' −' + (change.removed || 0)}${change.status ? ' · ' + escape(change.status) : ''}</div><button class="action-link" data-action="open-action" data-index="${index}">${escape(label)}</button></div></div>${change.why ? '<div class="action-why">' + markdown(change.why) + '</div>' : ''}</li>`;
    }).join('') || '';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
      h3{font-size:1em;font-weight:600;margin:14px 0 6px}.feedback-summary{margin:20px 0 14px;padding-top:8px;border-top:1px solid var(--vscode-panel-border)}.draft{padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.draft p{margin:4px 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.why p{margin:6px 0}.why ul{padding-left:20px}.why code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background)}
      body{padding:12px 16px;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.5}h2{font-size:1.08em;margin:6px 0 10px;font-weight:600}.status{color:var(--vscode-descriptionForeground);font-size:.92em}.why{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 14px}.muted{color:var(--vscode-descriptionForeground);font-size:.92em}.warning{color:var(--vscode-editorWarning-foreground);margin:12px 0}.actions{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0 10px;position:sticky;top:0;background:var(--vscode-sideBar-background)}button{border:1px solid transparent;border-radius:2px;padding:6px 10px;font:inherit;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);background:var(--vscode-textCodeBlock-background);padding:8px}.command{margin:12px 0}.scope{margin-top:10px}.empty{margin-top:12px}
      .review-controls{position:sticky;top:0;z-index:1;background:var(--vscode-sideBar-background);padding-top:4px}.review-controls .actions{position:static}.review-controls .feedback-summary{margin:2px 0 10px;padding-top:0;border:0}.review-controls h3{margin:4px 0}.review-controls p{margin:0 0 8px}.scope{margin-bottom:12px}
      .step-actions{list-style:none;padding:0;margin:8px 0 20px}.step-action{padding:12px 0;border-top:1px solid var(--vscode-panel-border)}.action-heading{display:flex;gap:9px;align-items:flex-start}.action-heading>div{min-width:0}.action-number{min-width:22px;height:22px;text-align:center;border:1px solid var(--vscode-panel-border);border-radius:50%;color:var(--vscode-descriptionForeground)}.action-link{display:block;background:transparent;color:var(--vscode-textLink-foreground);padding:0;text-align:left;overflow-wrap:anywhere;border:0}.action-link:hover{background:transparent;text-decoration:underline}.action-why p{margin:6px 0;overflow-wrap:anywhere}.step-action details{margin-top:8px}.step-action summary{cursor:pointer;color:var(--vscode-descriptionForeground)}
      </style></head><body>
      <div class="status">Pair ${escape(VERSION)} · ${escape(selected ? `${path.basename(selected.root)} · ${selected.sessionId.slice(0, 8)}` : 'Pair for Pi')} ${connected ? '' : '· disconnected'}</div>
      ${review ? `<h2>${escape(review.title)}</h2><div class="status">${escape(review.status)} · ${count} ${count === 1 ? 'action' : 'actions'}</div>
        <div class="review-controls" ${running ? 'hidden' : ''}><div class="actions"><button data-action="approve" ${approveDisabled}>${escape(actionLabel)}</button><button class="secondary" data-action="deny" ${disabled}>Deny</button><button class="secondary" data-action="note" ${disabled}>Deny with note</button></div>${feedbackController?.sidebar('controls') || ''}</div>
        <div class="why">${markdown(review.why)}</div><h3>Actions in order</h3><ol class="step-actions" aria-label="Step actions in execution order">${actions}</ol><div class="muted scope">Approval runs every action in this order. A failure stops the remaining actions.</div>`
        : `<p class="empty">${sessions.length > 1 ? 'Choose the Pi session you want to review.' : connected ? 'Connected. The next Pair proposal will appear here.' : 'Open the same folder in Pi and VS Code.'}</p>`}
      ${blocker ? `<p class="warning" role="status">${escape(blocker)}</p>` : ''}
      ${running ? '' : feedbackController?.sidebar(review ? 'drafts' : 'all') || ''}
      <button class="secondary" data-action="session">Select session</button>
      <script nonce="${nonce}">const api=acquireVsCodeApi();const identity=${currentIdentity};document.querySelectorAll('button[data-action]').forEach(button=>button.addEventListener('click',()=>api.postMessage({action:button.dataset.action,identity,index:Number(button.dataset.index)})));</script>
      </body></html>`;
  }

  const provider = {
    onDidChangeTreeData: changesChanged.event,
    getChildren: () => review ? review.changes.map((change, index) => ({ change, index, reviewId: review.id })) : [],
    getTreeItem: item => {
      const entry = new vscode.TreeItem(`${item.index + 1}. ${item.change.label}`, vscode.TreeItemCollapsibleState.None);
      const file = selected && containedFile(selected.root, item.change.label);
      entry.description = item.change.before !== undefined || item.change.after !== undefined ? `+${item.change.added || 0} −${item.change.removed || 0}` : item.change.kind;
      entry.tooltip = [item.change.label, item.change.kind, item.change.status].filter(Boolean).join('\n');
      if (file && (item.change.before !== undefined || item.change.after !== undefined)) entry.resourceUri = vscode.Uri.file(file);
      else entry.iconPath = new vscode.ThemeIcon('terminal');
      entry.command = { command: 'pair.openChange', title: 'Open action', arguments: [item] };
      return entry;
    }
  };
  const tree = vscode.window.createTreeView('pair.changes', { treeDataProvider: provider, showCollapseAll: false });
  context.subscriptions.push(tree);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent(uri) {
      const snapshot = documents.get(uri.toString());
      if (snapshot === undefined) throw new Error('This review snapshot is no longer available. Open the current Pair review.');
      return snapshot;
    }
  }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('pair.review', {
    resolveWebviewView(view) {
      reviewView = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.webview.html = renderPanel();
      view.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.action === 'session') return void chooseSession().catch(showError);
        if (message.action === 'desk') return void feedbackController.openDesk().catch(showError);
        if (message.action === 'send-feedback') return void feedbackController.sendFeedback().catch(showError);
        if (message.action === 'open-action') {
          if (sameReview(review, message.identity) && Number.isInteger(message.index)) void openChange(message.index).catch(showError);
          return;
        }
        if (!['approve', 'deny', 'note'].includes(message.action)) return;
        void decide(message.action, message.identity).catch(showError);
      }, undefined, context.subscriptions);
      view.onDidDispose(() => { if (reviewView === view) reviewView = undefined; }, undefined, context.subscriptions);
    }
  }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('pair.checkpoint', {
    resolveWebviewView(view) {
      checkpointView = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.webview.html = renderCheckpointPanel(checkpointOptions());
      view.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.action === 'add') void addConstraint(message).catch(showError);
        else if (message.action === 'remove') void removeConstraint(message).catch(showError);
      }, undefined, context.subscriptions);
      view.onDidDispose(() => { if (checkpointView === view) checkpointView = undefined; }, undefined, context.subscriptions);
    }
  }));

  function showError(error) { void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)); }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (disposed) return;
      if (force || Date.now() - lastDiscovery > 3000) {
        sessions = await discoverSessions(roots());
        lastDiscovery = Date.now();
        const requested = sessions.filter(session => Number.isFinite(session.focusRequestedAt) && session.focusRequestedAt > latestFocusTime)
          .sort((left, right) => right.focusRequestedAt - left.focusRequestedAt)[0];
        if (requested) {
          latestFocusTime = requested.focusRequestedAt;
          if (selected?.sessionId !== requested.sessionId) { selected = requested; review = undefined; memory = undefined; feedback = undefined; connected = false; etag = undefined; }
        }
        if (!selected && sessions.length === 1) { selected = sessions[0]; etag = undefined; }
        if (selected) {
          const registered = sessions.find(item => item.sessionId === selected.sessionId && canonicalRoot(item.root) === canonicalRoot(selected.root));
          if (registered) selected = registered;
          else {
            const replacements = sessions.filter(item => canonicalRoot(item.root) === canonicalRoot(selected.root));
            if (replacements.length === 1) {
              selected = replacements[0]; review = undefined; memory = undefined; feedback = undefined;
              connected = false; etag = undefined; autoOpened = undefined;
            } else {
              connected = false; etag = undefined;
              errorMessage = replacements.length > 1 ? 'Pi restarted. Select the conversation to reconnect.' : 'Pi is disconnected. Start Pi in this folder or use /pair code.';
              update(); return;
            }
          }
        }
      }
      if (!selected || !matchesWorkspace(selected)) { connected = false; update(); return; }
      const polledSession = { ...selected };
      try {
        const result = await request(polledSession, 'GET', '/review', undefined, force ? undefined : etag);
        if (disposed || selected?.sessionId !== polledSession.sessionId || !matchesWorkspace(polledSession)) return;
        let requestedFocus;
        if (!result.unchanged) {
          const value = result.data;
          if (value.version !== 1 || value.sessionId !== selected.sessionId || canonicalRoot(value.root) !== canonicalRoot(selected.root)
            || (value.review !== null && !validReview(value.review))
            || (value.memory != null && !validMemory(value.memory))
            || (value.feedback != null && !validFeedback(value.feedback))) throw new Error('Pair returned a review for a different session or an unsupported format.');
          review = value.review || undefined;
          progress = validProgress(value.progress, review) ? value.progress : [];
          terminal = value.terminal && value.terminal.reviewId === review?.id && Number.isInteger(value.terminal.index) && review.changes[value.terminal.index]?.interactive && typeof value.terminal.runId === 'string' ? value.terminal : undefined;
          memory = value.memory || undefined;
          feedback = value.feedback || undefined;
          etag = result.etag;
          if (typeof value.focus?.id === 'string' && Number.isInteger(value.focus.selected) && value.focus.selected >= 0 && !handledFocus.has(value.focus.id)) {
            requestedFocus = value.focus;
            handledFocus.add(value.focus.id);
          }
        }
        connected = true;
        errorMessage = '';
        update();
        const pendingKey = review?.pending ? selected.sessionId + ':' + review.id : undefined;
        if (requestedFocus || pendingKey && pendingKey !== autoOpened && vscode.workspace.getConfiguration('pair').get('openReviewAutomatically', true)) {
          autoOpened = pendingKey;
          selectedIndex = requestedFocus?.selected || 0;
          void openReview().catch(showError);
        }
      } catch (error) {
        if (selected?.sessionId !== polledSession.sessionId) return;
        connected = false;
        errorMessage = `Pi is disconnected. ${error.message}`;
        etag = undefined;
        update();
      }
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  async function chooseSession() {
    sessions = await discoverSessions(roots());
    if (!sessions.length) { await vscode.window.showInformationMessage('No Pair session matches this workspace. Start Pi in this folder and reload Pair.'); return; }
    const choice = await vscode.window.showQuickPick(sessions.map(session => ({ label: `${path.basename(session.root)} · ${session.sessionId.slice(0, 8)}`, description: session.root, detail: `Pi process ${session.pid}`, session })), { title: 'Select the Pi session to review', placeHolder: 'Only sessions for this workspace are shown' });
    if (!choice) return;
    selected = choice.session;
    review = undefined;
    memory = undefined;
    feedback = undefined;
    connected = false;
    etag = undefined;
    autoOpened = undefined;
    await refresh(true);
    await vscode.commands.executeCommand('pair.review.focus');
  }

  function makeDocument(currentSession, currentReview, change, side, content, filename = change.label) {
    const safePath = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: currentSession.sessionId, path: `/${currentReview.id}/${side}/${safePath}`, query: new URLSearchParams(identity(currentReview)).toString() });
    // Snapshots are append-only; a later result never changes what an older diff showed.
    if (!documents.has(uri.toString())) documents.set(uri.toString(), content);
    if (['before', 'proposed', 'command', 'comparison'].includes(side)) feedbackController?.mapDocument(uri, currentReview, currentReview.changes.indexOf(change), side);
    return uri;
  }

  function pruneSnapshots() {
    if (documents.size <= 64) return;
    const open = new Set(vscode.workspace.textDocuments.map(document => document.uri.toString()));
    for (const key of documents.keys()) {
      if (documents.size <= 64) break;
      if (open.has(key)) continue;
      const uri = vscode.Uri.parse(key);
      const query = new URLSearchParams(uri.query);
      if (uri.authority === selected?.sessionId && sameReview(review, { reviewId: query.get('reviewId'), revision: Number(query.get('revision')), fingerprint: query.get('fingerprint') })) continue;
      documents.delete(key);
      feedbackController?.forgetDocument(key);
    }
  }

  async function languageFor(change, currentSession, virtualDocument) {
    const realPath = containedFile(currentSession.root, change.label);
    if (realPath) {
      const uri = vscode.Uri.file(realPath);
      try { return (await vscode.workspace.openTextDocument(uri)).languageId; } catch { /* New file: resolve the resource's associations and grammar. */ }
      const associations = vscode.workspace.getConfiguration('files', uri).get('associations', {});
      const explicit = associatedLanguage(associations, realPath, currentSession.root);
      if (explicit) return explicit;
    }
    return virtualDocument.languageId;
  }

  async function openChange(value = selectedIndex) {
    if (!selected || !review || !matchesWorkspace(selected)) return;
    if (typeof value === 'object' && value?.reviewId !== review.id) throw new Error('That file belongs to an older review. Open the current change.');
    const index = typeof value === 'number' ? value : value?.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= review.changes.length) return;
    selectedIndex = index;
    await openSnapshot(structuredClone(review), index);
  }

  async function openSnapshot(snapshot, index, anchor = {}) {
    if (!selected || !matchesWorkspace(selected) || !snapshot?.changes[index]) return;
    if (typeof snapshot.changes[index].command === 'string' && !anchor.startLine && !anchor.native && !anchor.compare) {
      commandCenter.open(snapshot, index);
      return;
    }
    const currentSession = { ...selected };
    const currentReview = snapshot;
    const change = currentReview.changes[index];
    const selection = Number.isInteger(anchor.startLine) && vscode.Range ? new vscode.Range(anchor.startLine - 1, 0, anchor.endLine - 1, 0) : undefined;
    let anchorUri;
    if (change.before !== undefined && change.after !== undefined) {
      const revised = anchor.compare?.changes.find(value => value.label === change.label && typeof value.after === 'string');
      if (anchor.compare && !revised) throw new Error('The revised proposal no longer contains this file. The original anchored diff remains available.');
      const left = revised ? makeDocument(currentSession, currentReview, change, 'comparison', change.after, `${anchor.compare.id}/previous/${change.label}`)
        : makeDocument(currentSession, currentReview, change, 'before', change.before);
      const right = revised ? makeDocument(currentSession, anchor.compare, revised, 'proposed', revised.after)
        : makeDocument(currentSession, currentReview, change, 'proposed', change.after);
      const beforeDoc = await vscode.workspace.openTextDocument(left);
      const afterDoc = await vscode.workspace.openTextDocument(right);
      const language = await languageFor(change, currentSession, afterDoc);
      if (language && (await vscode.languages.getLanguages()).includes(language)) {
        await vscode.languages.setTextDocumentLanguage(beforeDoc, language);
        await vscode.languages.setTextDocumentLanguage(afterDoc, language);
      }
      anchorUri = anchor.side === 'before' ? left : right;
      await vscode.commands.executeCommand('vscode.diff', left, right, `${change.label} — ${revised ? 'Since feedback' : 'Before ↔ Proposed'}`, { preview: true, preserveFocus: false, ...(vscode.ViewColumn ? { viewColumn: vscode.ViewColumn.Active } : {}), ...(selection ? { selection } : {}) });
    } else {
      const command = change.command !== undefined;
      const content = command ? change.command : change.text || change.diff || 'No complete file snapshot was recorded for this result.';
      const name = command ? /powershell/i.test(change.kind) ? 'command.ps1' : 'command.sh' : 'result.txt';
      if (anchor.compare) throw new Error('Command feedback keeps its exact original command. Open the latest proposal to review its replacement.');
      const uri = makeDocument(currentSession, currentReview, change, command ? 'command' : 'details', content, `${index}-${name}`);
      anchorUri = uri;
      const document = await vscode.workspace.openTextDocument(uri);
      const language = /powershell/i.test(change.kind) ? 'powershell' : 'shellscript';
      if (command && (await vscode.languages.getLanguages()).includes(language)) await vscode.languages.setTextDocumentLanguage(document, language);
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false, ...(vscode.ViewColumn ? { viewColumn: vscode.ViewColumn.Active } : {}), ...(selection ? { selection } : {}) });
    }
    if (selection) {
      const editor = vscode.window.visibleTextEditors?.find(value => value.document.uri.toString() === anchorUri.toString());
      if (editor) {
        if (vscode.Selection) editor.selection = new vscode.Selection(selection.start, selection.end);
        editor.revealRange(selection, vscode.TextEditorRevealType?.InCenterIfOutsideViewport);
      }
    }
    pruneSnapshots();
  }

  async function openReview() {
    await vscode.commands.executeCommand('workbench.view.extension.pair');
    await vscode.commands.executeCommand('pair.review.focus');
    if (review?.changes.length) await openChange(Math.min(selectedIndex, review.changes.length - 1));
  }

  function expectedIdentity(value) {
    if (value?.reviewId) return value;
    const uri = value?.scheme ? value : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SCHEME) {
      if (uri.authority !== selected?.sessionId) throw new Error('This diff belongs to a different Pi session. Open the current review before responding.');
      const query = new URLSearchParams(uri.query);
      const snapshot = { reviewId: query.get('reviewId'), revision: Number(query.get('revision')), fingerprint: query.get('fingerprint') };
      return sameReview(review, snapshot) ? decisionIdentity(review) : snapshot;
    }
    return decisionIdentity(review);
  }

  async function decide(action, suppliedIdentity) {
    const expected = expectedIdentity(suppliedIdentity);
    const currentSession = selected && { ...selected };
    if (!currentSession || !connected || !matchesWorkspace(currentSession)) throw new Error('Reconnect to the matching Pi session before responding.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before responding to Pair.');
    if (!sameDecision(review, expected) || !review.pending) throw new Error('This proposal is no longer pending. Review the current step.');
    if (busy) return;
    let note;
    if (action === 'note') {
      note = await vscode.window.showInputBox({ title: 'Deny step with a note', prompt: 'What should the agent change? Nothing will run.', placeHolder: 'Explain what should change', ignoreFocusOut: true,
        validateInput: value => !value.trim() ? 'Enter a note, or press Escape to cancel.' : value.length > 1800 ? 'Keep the note under 1,800 characters.' : undefined });
      if (note === undefined) return;
      note = note.trim();
    }
    if (selected?.sessionId !== currentSession.sessionId || !matchesWorkspace(currentSession) || !connected || !sameDecision(review, expected) || !review.pending) throw new Error('The review changed while you were responding. Open the current proposal.');
    if (action === 'approve' && dirtyFiles().length) throw new Error(`Save or discard unsaved changes in ${dirtyFiles().join(', ')} before approving. Pair does not overwrite editor buffers.`);
    if (action === 'approve' && alteredSnapshots().length) throw new Error('A review snapshot was modified. Close its diff and reopen the Pair review before approving.');
    if (action === 'approve' && feedbackController?.blocksApproval()) throw new Error('Send or remove your draft feedback before approving this step.');
    busy = true;
    update();
    try {
      await request(currentSession, 'POST', '/decision', { ...expected, action: action === 'approve' ? 'approve' : 'deny', ...(note ? { note } : {}) });
      if (sameDecision(review, expected)) review = { ...review, pending: false, status: action === 'approve' ? 'Approved' : 'Denied' };
      await refresh(true);
    } catch (error) {
      await refresh(true);
      throw error;
    } finally { busy = false; update(); }
  }

  function memoryTarget(supplied) {
    if (!canEditMemory()) throw new Error('Connect to a trusted matching Pi workspace before changing constraints.');
    const expected = supplied || { sessionId: selected.sessionId, revision: memory.revision };
    if (expected.sessionId !== selected.sessionId || expected.revision !== memory.revision) throw new Error('The checkpoint or session changed. Open its current constraints again.');
    return { session: { ...selected }, revision: memory.revision };
  }

  function assertMemoryTarget(target) {
    if (!canEditMemory() || selected?.sessionId !== target.session.sessionId || !matchesWorkspace(target.session)
      || memory?.revision !== target.revision) throw new Error('The checkpoint or session changed while you were responding. Open its current constraints again.');
  }

  async function saveConstraintChange(target, change) {
    assertMemoryTarget(target);
    memoryBusy = true;
    update();
    try {
      await request(target.session, 'POST', '/memory', { revision: target.revision, ...change });
      etag = undefined;
      await refresh(true);
    } catch (error) {
      await refresh(true);
      throw error;
    } finally { memoryBusy = false; update(); }
  }

  async function addConstraint(supplied) {
    const target = memoryTarget(supplied);
    const text = await vscode.window.showInputBox({ title: 'Pin a human constraint', prompt: 'An instruction for this work. Adding it cancels a pending review; it never grants execution permission.',
      placeHolder: 'For example: Skip the full suite; use the focused runtime tests.', ignoreFocusOut: true,
      validateInput: value => !value.trim() ? 'Enter a constraint, or press Escape to cancel.' : value.trim().length > 300 ? 'Keep the constraint under 300 characters.' : undefined });
    if (text === undefined) return;
    assertMemoryTarget(target);
    const choice = await vscode.window.showQuickPick([
      { label: 'This task', description: 'Until removed or new Pair work starts', scope: 'task' },
      { label: 'Current or next turn', description: 'Current run if working; otherwise your next message', scope: 'turn' },
    ], { title: 'How long should this constraint stay pinned?', ignoreFocusOut: true });
    if (!choice) return;
    await saveConstraintChange(target, { action: 'add_constraint', text: text.trim(), scope: choice.scope });
  }

  async function removeConstraint(supplied) {
    const target = memoryTarget(supplied);
    if (!memory.constraints.length) return;
    const choice = await vscode.window.showQuickPick(memory.constraints.map(constraint => ({ label: constraint.text, description: scopeLabel(constraint.scope, constraint.pendingTurn), id: constraint.id })),
      { title: 'Remove a pinned constraint', placeHolder: 'Removing a constraint cancels a pending review; it does not approve anything.', ignoreFocusOut: true });
    if (!choice) return;
    await saveConstraintChange(target, { action: 'remove_constraint', id: choice.id });
  }

  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await callback(...args); } catch (error) { showError(error); throw error; }
  }));
  commandCenter = createCommandCenter(vscode, context, { getState: liveState, sendTerminal: body => { if(!selected || !connected || !matchesWorkspace(selected) || !vscode.workspace.isTrusted)throw new Error('Reconnect to the trusted Pi workspace.'); return request({...selected},'POST','/terminal',body); }, openNative: (snapshot,index) => openSnapshot(snapshot,index,{native:true}), showError });
  feedbackController = createFeedbackController(vscode, context, { getState: liveState, getSession: () => selected && { ...selected }, matchesWorkspace: () => matchesWorkspace(selected), request,
    refresh: () => refresh(true), onChanged: update, alteredSnapshots, openSnapshot, openCurrent: openChange, chooseSession, showError });
  register('pair.reviewDesk', () => feedbackController.openDesk());
  register('pair.addAskFeedback', input => feedbackController.addFeedback('ask', input));
  register('pair.addRevisionFeedback', input => feedbackController.addFeedback('revise', input));
  register('pair.saveAskComment', input => feedbackController.addFeedback('ask', input));
  register('pair.saveRevisionComment', input => feedbackController.addFeedback('revise', input));
  register('pair.editDraft', input => feedbackController.editDraft(input));
  register('pair.removeDraft', input => feedbackController.removeDraft(input));
  register('pair.sendFeedback', () => feedbackController.sendFeedback());
  register('pair.sendQuestion', input => feedbackController.sendQuestion(input));
  register('pair.openFeedback', input => feedbackController.openFeedback(input));
  register('pair.addressFeedback', input => feedbackController.addressFeedback(input));
  register('pair.review', openReview);
  register('pair.checkpoint', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.pair');
    await vscode.commands.executeCommand('pair.checkpoint.focus');
  });
  register('pair.addConstraint', addConstraint);
  register('pair.removeConstraint', removeConstraint);
  register('pair.openChange', openChange);
  register('pair.openCommandSource', () => commandCenter.openSource());
  register('pair.nextFile', () => openChange(review ? (selectedIndex + 1) % review.changes.length : 0));
  register('pair.previousFile', () => openChange(review ? (selectedIndex + review.changes.length - 1) % review.changes.length : 0));
  register('pair.selectSession', chooseSession);
  register('pair.refresh', () => refresh(true));
  register('pair.approve', expected => decide('approve', expected));
  register('pair.deny', expected => decide('deny', expected));
  register('pair.denyWithNote', expected => decide('note', expected));
  context.subscriptions.push(vscode.window.registerUriHandler({
    async handleUri(uri) {
      try {
        if (uri.path !== '/review') return;
        const params = new URLSearchParams(uri.query);
        const requestedRoot = params.get('root');
        const sessionId = params.get('session');
        if (!requestedRoot || !roots().some(root => canonicalRoot(root) === canonicalRoot(requestedRoot))) throw new Error('Open the Pi working directory in this VS Code window before opening its review.');
        sessions = await discoverSessions(roots());
        const target = sessions.find(session => session.sessionId === sessionId && canonicalRoot(session.root) === canonicalRoot(requestedRoot));
        if (!target) throw new Error('That Pi session is no longer available. Refresh Pair or select its active session.');
        selected = target;
        review = undefined;
        memory = undefined;
        feedback = undefined;
        connected = false;
        etag = undefined;
        await refresh(true);
        await openReview();
      } catch (error) { showError(error); }
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { connected = false; update(); void refresh(true).catch(showError); }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(update));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { if (['file', SCHEME].includes(event.document.uri.scheme)) update(); }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(update));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'file') update(); pruneSnapshots(); }));
  const interval = setInterval(() => { void refresh().catch(error => { connected = false; errorMessage = error.message; update(); }); }, 1500);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(interval); documents.clear(); } });
  void refresh(true).catch(showError);
  return { getCommandViewState: () => commandCenter.getState(), getState: state, getReviewState: () => feedbackController.getState(), refresh: () => refresh(true) };
}

module.exports = { activate };
