'use strict';
const VERSION = require('./package.json').version;
const vscode = require('vscode');
const path = require('node:path');
const { canonicalRoot, containedFile, discoverSessions, request, validReview, identity, sameReview, decisionIdentity, sameDecision, associatedLanguage } = require('./client.cjs');
const { renderReviewPanel } = require('./review-panel.cjs');
const { validProgress } = require('./command-view.cjs');
const { createCommandCenter } = require('./command-center.cjs');

const SCHEME = 'pair-review';
function activate(context) {
  const documents = new Map();
  let selected;
  let sessions = [];
  let review;
  let progress = [];
  let terminal;
  let commandCenter;
  let connected = false;
  let busy = false;
  let errorMessage = '';
  let etag;
  let refreshPromise;
  let disposed = false;
  let reviewView;
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
  const canDecide = () => connected && !busy && matchesWorkspace(selected) && review?.pending && vscode.workspace.isTrusted;
  const canApprove = () => canDecide() && !dirtyFiles().length && !alteredSnapshots().length;
  const liveState = () => ({ sessionId: selected?.sessionId, root: selected?.root, connected, review, progress, terminal, connectionError: errorMessage });
  const state = () => structuredClone(liveState());
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
  status.command = 'pair.review';
  context.subscriptions.push(status);

  function update() {
    if (disposed) return;
    commandCenter?.sync();
    const signature = JSON.stringify([selected?.sessionId, connected, busy, errorMessage, review?.id, review?.revision, review?.fingerprint, review?.gate, review?.status, review?.pending, sessions.length, vscode.workspace.isTrusted, dirtyFiles(), alteredSnapshots().length, selectedIndex, review?.changes.map(change => change.status)]);
    if (signature === displayedState) return;
    displayedState = signature;

    void vscode.commands.executeCommand('setContext', 'pair.canDecide', !!canDecide()).then(undefined, () => {});
    void vscode.commands.executeCommand('setContext', 'pair.canApprove', !!canApprove()).then(undefined, () => {});
    status.text = connected ? review?.pending ? '$(git-pull-request) Pair: review' : '$(check) Pair' : '$(debug-disconnect) Pair';
    status.tooltip = connected ? `Pair · ${selected.root}\n${review?.title || 'Waiting for a proposal'}` : errorMessage || 'Open Pair to connect to a Pi session in this project.';
    if (roots().length && (selected || sessions.length)) status.show(); else status.hide();
    if (reviewView) reviewView.webview.html = renderPanel();
  }

  function renderPanel() {
    return renderReviewPanel({ version: VERSION, session: selected, sessions, connected, busy, review, selectedIndex,
      trusted: vscode.workspace.isTrusted, canDecide: !!canDecide(), canApprove: !!canApprove(),
      dirtyFiles: dirtyFiles(), alteredSnapshots: alteredSnapshots().length, errorMessage });
  }

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
          if (selected?.sessionId !== requested.sessionId) { selected = requested; review = undefined; connected = false; etag = undefined; }
        }
        if (!selected && sessions.length === 1) { selected = sessions[0]; etag = undefined; }
        if (selected) {
          const registered = sessions.find(item => item.sessionId === selected.sessionId && canonicalRoot(item.root) === canonicalRoot(selected.root));
          if (registered) selected = registered;
          else {
            const replacements = sessions.filter(item => canonicalRoot(item.root) === canonicalRoot(selected.root));
            if (replacements.length === 1) {
              selected = replacements[0]; review = undefined;
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
            || (value.review !== null && !validReview(value.review))) throw new Error('Pair returned a review for a different session or an unsupported format.');
          const nextReview = value.review || undefined;
          selectedIndex = review?.id === nextReview?.id
            ? Math.min(selectedIndex, Math.max(0, (nextReview?.changes.length ?? 0) - 1)) : 0;
          review = nextReview;
          progress = validProgress(value.progress, review) ? value.progress : [];
          terminal = value.terminal && value.terminal.reviewId === review?.id && Number.isInteger(value.terminal.index) && review.changes[value.terminal.index]?.interactive && typeof value.terminal.runId === 'string' ? value.terminal : undefined;
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
    update();
    await openSnapshot(structuredClone(review), index);
  }

  async function openSnapshot(snapshot, index, options = {}) {
    if (!selected || !matchesWorkspace(selected) || !snapshot?.changes[index]) return;
    const currentSession = { ...selected };
    const change = snapshot.changes[index];
    if (typeof change.command === 'string' && !options.native) {
      commandCenter.open(snapshot, index);
      return;
    }
    if (change.before !== undefined && change.after !== undefined) {
      const left = makeDocument(currentSession, snapshot, change, 'before', change.before);
      const right = makeDocument(currentSession, snapshot, change, 'proposed', change.after);
      const beforeDoc = await vscode.workspace.openTextDocument(left);
      const afterDoc = await vscode.workspace.openTextDocument(right);
      const language = await languageFor(change, currentSession, afterDoc);
      if (language && (await vscode.languages.getLanguages()).includes(language)) {
        await vscode.languages.setTextDocumentLanguage(beforeDoc, language);
        await vscode.languages.setTextDocumentLanguage(afterDoc, language);
      }
      await vscode.commands.executeCommand('vscode.diff', left, right, `${change.label} — Before ↔ Proposed`, { preview: true, preserveFocus: false, ...(vscode.ViewColumn ? { viewColumn: vscode.ViewColumn.Active } : {}) });
    } else {
      const command = change.command !== undefined;
      const content = command ? change.command : change.text || change.diff || 'No complete file snapshot was recorded for this result.';
      const name = command ? /powershell/i.test(change.kind) ? 'command.ps1' : 'command.sh' : 'result.txt';
      const uri = makeDocument(currentSession, snapshot, change, command ? 'command' : 'details', content, `${index}-${name}`);
      const document = await vscode.workspace.openTextDocument(uri);
      const language = /powershell/i.test(change.kind) ? 'powershell' : 'shellscript';
      if (command && (await vscode.languages.getLanguages()).includes(language)) await vscode.languages.setTextDocumentLanguage(document, language);
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false, ...(vscode.ViewColumn ? { viewColumn: vscode.ViewColumn.Active } : {}) });
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

  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await callback(...args); } catch (error) { showError(error); throw error; }
  }));
  commandCenter = createCommandCenter(vscode, context, { getState: liveState, sendTerminal: body => { if(!selected || !connected || !matchesWorkspace(selected) || !vscode.workspace.isTrusted)throw new Error('Reconnect to the trusted Pi workspace.'); return request({...selected},'POST','/terminal',body); }, openNative: (snapshot,index) => openSnapshot(snapshot,index,{native:true}), showError });
  register('pair.review', openReview);
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
  return { getCommandViewState: () => commandCenter.getState(), getState: state, refresh: () => refresh(true) };
}

module.exports = { activate };
