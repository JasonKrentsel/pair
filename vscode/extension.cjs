'use strict';
const VERSION = require('./package.json').version;
const vscode = require('vscode');
const path = require('node:path');
const { canonicalRoot, containedFile, discoverSessions, request, validReview, identity, sameReview, decisionIdentity, sameDecision, associatedLanguage } = require('./client.cjs');
const { renderReviewPanel } = require('./review-panel.cjs');
const { renderActionConversation, actionConversationUpdate } = require('./action-conversation.cjs');
const { validProgress } = require('./command-view.cjs');
const { createCommandCenter } = require('./command-center.cjs');

const SCHEME = 'pair-review';
function activate(context) {
  const documents = new Map();
  const documentTargets = new Map();
  let selected;
  let sessions = [];
  let review;
  let progress = [];
  let terminal;
  let actionConversations = [];
  let conversationAvailable = false;
  let activeConversationId;
  let adoptedRevision;
  let conversationBusy = false;
  let displayedConversation;
  let displayedConversationUpdate;
  let commandCenter;
  let connected = false;
  let busy = false;
  let errorMessage = '';
  let etag;
  let refreshPromise;
  let queuedForcedRefresh;
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
  const liveState = () => ({ actionConversations, conversationAvailable, activeConversationId, sessionId: selected?.sessionId, root: selected?.root, connected, review, progress, terminal, connectionError: errorMessage });
  const state = () => structuredClone(liveState());
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
  status.command = 'pair.review';
  context.subscriptions.push(status);

  const activeConversation = () => actionConversations.find(item => item.id === activeConversationId);
  const conversationAssets = () => reviewView?.webview.asWebviewUri && context.extensionUri ? Object.fromEntries(['vendor/highlight.js','vendor/powershell.js'].map(name => [name,reviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media',name)).toString()])) : undefined;
  const conversationOptions = () => ({ review,adoptedRevision:adoptedRevision?.sessionId === selected?.sessionId ? adoptedRevision : undefined,index:activeConversation()?.index ?? selectedIndex,conversation:activeConversation(),connected,trusted:vscode.workspace.isTrusted,busy:conversationBusy,errorMessage:connected?'':errorMessage,assets:conversationAssets() });
  const scopeDecoration = vscode.window.createTextEditorDecorationType?.({isWholeLine:true,backgroundColor:new vscode.ThemeColor('editor.rangeHighlightBackground'),borderWidth:'0 0 0 2px',borderStyle:'solid',borderColor:new vscode.ThemeColor('focusBorder')});
  if(scopeDecoration)context.subscriptions.push(scopeDecoration);
  let decoratedScope;
  function updateScopeDecoration(force=false) {
    if(!scopeDecoration)return;
    const conversation=activeConversation(),scope=conversation?.scope || conversation;
    const current=conversation && sameDecision(review,conversation.identity || conversation) && review?.pending && !['closed','stale'].includes(conversation.status);
    const key=current && scope?.startLine ? [selected?.sessionId,conversation.id,scope.startLine,scope.endLine].join(':') : '';
    if(!force && key===decoratedScope)return;
    decoratedScope=key;
    for(const editor of vscode.window.visibleTextEditors || []) {
      const target=documentTargets.get(editor.document.uri.toString());
      const matches=key && target?.sessionId===selected?.sessionId && target.index===conversation.index && ['proposed','command'].includes(target.side) && sameReview(review,target.identity);
      editor.setDecorations(scopeDecoration,matches ? [new vscode.Range(scope.startLine-1,0,(scope.endLine || scope.startLine)-1,Number.MAX_SAFE_INTEGER)] : []);
    }
  }
  const canDiscuss = () => connected && !busy && !conversationBusy && conversationAvailable && review?.pending && matchesWorkspace(selected) && vscode.workspace.isTrusted;
  function updateConversation() {
    const conversation = activeConversation();
    if (!activeConversationId || !conversation || !reviewView) return false;
    const key = selected?.sessionId + ':' + conversation.id;
    const options = conversationOptions();
    if (displayedConversation !== key) {
      reviewView.webview.html = renderActionConversation(options);
      displayedConversation = key;
      displayedConversationUpdate = undefined;
    }
    const patch = actionConversationUpdate(options), signature = JSON.stringify(patch);
    if (signature !== displayedConversationUpdate) { displayedConversationUpdate = signature; void reviewView.webview.postMessage?.(patch); }
    return true;
  }

  function update() {
    if (disposed) return;
    commandCenter?.sync();
    updateScopeDecoration();
    void vscode.commands.executeCommand('setContext', 'pair.canDiscuss', !!canDiscuss()).then(undefined, () => {});
    const showingConversation = updateConversation();
    const signature = JSON.stringify([selected?.sessionId, connected, busy, errorMessage, review?.id, review?.revision, review?.fingerprint, review?.gate, review?.status, review?.pending, sessions.length, vscode.workspace.isTrusted, dirtyFiles(), alteredSnapshots().length, selectedIndex, conversationAvailable, activeConversationId, conversationBusy, actionConversations.map(item => [item.id,item.status,!!item.candidate]), review?.changes.map(change => change.status)]);
    if (signature === displayedState) return;
    displayedState = signature;

    void vscode.commands.executeCommand('setContext', 'pair.canDecide', !!canDecide()).then(undefined, () => {});
    void vscode.commands.executeCommand('setContext', 'pair.canApprove', !!canApprove()).then(undefined, () => {});
    status.text = connected ? review?.pending ? '$(git-pull-request) Pair: review' : '$(check) Pair' : '$(debug-disconnect) Pair';
    status.tooltip = connected ? `Pair · ${selected.root}\n${review?.title || 'Waiting for a proposal'}` : errorMessage || 'Open Pair to connect to a Pi session in this project.';
    if (roots().length && (selected || sessions.length)) status.show(); else status.hide();
    if (reviewView && !showingConversation) { displayedConversation = undefined; reviewView.webview.html = renderPanel(); }
  }

  function renderPanel() {
    return renderReviewPanel({ conversationAvailable: !!canDiscuss(), actionConversations, version: VERSION, session: selected, sessions, connected, busy, review, selectedIndex,
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
      view.webview.options = { enableScripts: true, localResourceRoots: context.extensionUri ? [vscode.Uri.joinPath(context.extensionUri,'media')] : [] };
      displayedConversation = undefined;
      if (!updateConversation()) view.webview.html = renderPanel();
      view.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.action?.startsWith('conversation-')) { void handleConversationMessage(message).catch(error => { void reviewView?.webview.postMessage?.({type:'action-conversation-error',id:message.conversationId,text:error.message}); }); return; }
        if (message.action === 'chat-action') { void openActionConversation({index:message.index,identity:message.identity,conversationId:message.conversationId}).catch(showError); return; }
        if (message.action === 'session') return void chooseSession().catch(showError);
        if (message.action === 'open-action') {
          if (sameReview(review, message.identity) && Number.isInteger(message.index)) void openChange(message.index).catch(showError);
          return;
        }
        if (!['approve', 'deny', 'note'].includes(message.action)) return;
        void decide(message.action, message.identity).catch(showError);
      }, undefined, context.subscriptions);
      view.onDidDispose(() => { if (reviewView === view) { reviewView = undefined; displayedConversation = undefined; } }, undefined, context.subscriptions);
    }
  }));
  function showError(error) { void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)); }

  async function refresh(force = false) {
    if (refreshPromise) {
      if (!force) return refreshPromise;
      // A mutation needs a snapshot requested after it completed. Reusing an
      // older in-flight GET can hide a new conversation or an adopted revision.
      // Calls waiting on the same poll share one follow-up request.
      if (!queuedForcedRefresh) {
        queuedForcedRefresh = refreshPromise.catch(() => {}).then(() => {
          queuedForcedRefresh = undefined;
          return refresh(true);
        });
      }
      return queuedForcedRefresh;
    }
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
          actionConversations = Array.isArray(value.actionConversations) ? value.actionConversations.filter(item => item && typeof item.id === 'string' && typeof item.reviewId === 'string' && Number.isInteger(item.index) && Array.isArray(item.messages) && item.messages.every(message => message && typeof message.text === 'string' && ['user','assistant'].includes(message.role))) : [];
          conversationAvailable = value.conversationAvailable === true;
          if (!actionConversations.some(item => item.id === activeConversationId)) activeConversationId = undefined;
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
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: currentSession.sessionId, path: `/${currentReview.id}/${side}/${Math.max(0,currentReview.changes.indexOf(change))}/${safePath}`, query: new URLSearchParams(identity(currentReview)).toString() });
    // Snapshots are append-only; a later result never changes what an older diff showed.
    if (!documents.has(uri.toString())) documents.set(uri.toString(), content);
    documentTargets.set(uri.toString(), {sessionId:currentSession.sessionId,identity:decisionIdentity(currentReview),index:currentReview.changes.indexOf(change),side});
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
      documentTargets.delete(key);
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
    activeConversationId = undefined;
    displayedConversation = undefined;
    update();
    await vscode.commands.executeCommand('workbench.view.extension.pair');
    await vscode.commands.executeCommand('pair.review.focus');
    if (review?.changes.length) await openChange(Math.min(selectedIndex, review.changes.length - 1));
  }


  function selectionTarget() {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const target = uri && documentTargets.get(uri.toString());
    if (!target || target.sessionId !== selected?.sessionId || !sameReview(review,target.identity)) throw new Error('Open the current Pair proposed diff or command source before selecting lines.');
    if (!['proposed','command'].includes(target.side)) throw new Error('Select lines on the Proposed side or in the command source. Earlier and candidate snapshots cannot change the pending step.');
    const content = documents.get(uri.toString());
    if (editor.document.getText() !== content) throw new Error('This snapshot was modified. Close it and reopen the current Pair action before discussing its lines.');
    const selection = editor.selection;
    if (!selection || selection.isEmpty) throw new Error('Select the function or lines you want to discuss first.');
    const startLine = selection.start.line + 1;
    const endLine = Math.max(startLine,selection.end.line + (selection.end.character === 0 ? 0 : 1));
    if (startLine < 1 || endLine > content.split(/\r\n|\r|\n/).length || endLine-startLine >= 400) throw new Error('Select up to 400 lines from the proposed action.');
    return {index:target.index,identity:decisionIdentity(review),startLine,endLine};
  }

  async function openActionConversation(input = {}) {
    const target = typeof input === 'number' ? {index:input} : input || {};
    const index = Number.isInteger(target.index) ? target.index : selectedIndex;
    const expected = target.identity || decisionIdentity(review);
    if (!canDiscuss()) throw new Error('Open a pending step in a trusted workspace with the updated Pi extension to discuss an action.');
    if (!sameDecision(review,expected) || !review.changes[index]) throw new Error('This step changed. Open the current action before starting a conversation.');
    const existing = target.conversationId && actionConversations.find(item=>item.id===target.conversationId && item.index===index && sameDecision(review,item.identity || item));
    if(target.conversationId && !existing)throw new Error('This conversation belongs to an earlier version. Open the current action.');
    const startLine=target.startLine ?? existing?.startLine ?? existing?.scope?.startLine;
    const endLine=target.endLine ?? existing?.endLine ?? existing?.scope?.endLine;
    const session = {...selected};
    conversationBusy = true; update();
    try {
      const result = await request(session,'POST','/conversation',{action:'open',...expected,index,...(startLine ? {startLine,endLine} : {})});
      if (selected?.sessionId !== session.sessionId) return;
      await refresh(true);
      const id = result.data?.conversationId;
      if (typeof id !== 'string' || !actionConversations.some(item=>item.id===id)) throw new Error('Pi did not open the action conversation. Refresh Pair and try again.');
      selectedIndex = index; activeConversationId = id;displayedConversation = undefined;
      await vscode.commands.executeCommand('workbench.view.extension.pair');
      await vscode.commands.executeCommand('pair.review.focus');
      update();
    } finally {conversationBusy=false;update();}
    return {conversationId:activeConversationId};
  }

  async function handleConversationMessage(message) {
    if (message.action === 'conversation-back') {if(message.conversationId!==activeConversationId)return;activeConversationId=undefined;displayedConversation=undefined;update();return;}
    const conversation = activeConversation();
    if (!conversation || message.conversationId !== conversation.id) throw new Error('This conversation is no longer selected. Open it from the current step.');
    if (message.action === 'conversation-ready') {displayedConversationUpdate=undefined;updateConversation();return;}
    if (message.action === 'conversation-open-action') {await openChange(conversation.index);return;}
    if (message.action === 'conversation-preview') {await previewConversationCandidate(conversation);return;}
    const action = {'conversation-send':'send','conversation-stop':'stop','conversation-adopt':'adopt','conversation-discard':'discard'}[message.action];
    if (!action) return;
    if (!connected || !selected || !matchesWorkspace(selected) || !vscode.workspace.isTrusted) throw new Error('Reconnect to the trusted Pi workspace to continue.');
    const expected = message.identity;
    if (!sameDecision(review,expected) || !review.pending || conversation.reviewId !== review.id) throw new Error('This step changed or finished. Return to the current step.');
    if (conversationBusy) return;
    const session={...selected};
    const body={action,...expected,index:conversation.index,conversationId:conversation.id};
    if(action==='send') {
      if(message.mode !== 'chat'||typeof message.text!=='string'||!message.text.trim()||message.text.length>3000||typeof message.requestId!=='string')throw new Error('Enter a message of up to 3,000 characters.');
      Object.assign(body,{mode:message.mode,text:message.text.trim(),requestId:message.requestId});
    }
    if(action==='adopt'||action==='discard') {
      if(typeof message.candidateId!=='string'||conversation.candidate?.id!==message.candidateId)throw new Error('That suggested revision changed. Inspect its current diff first.');
      body.candidateId=message.candidateId;
    }
    if(action==='adopt'&&(dirtyFiles().length||alteredSnapshots().length))throw new Error('Save affected files and reopen any modified review snapshots before using a revision.');
    conversationBusy=true;update();
    try {
      const result = await request(session,'POST','/conversation',body);
      if(selected?.sessionId!==session.sessionId)return;
      // Only a successful adoption receipt may replace the stale-chat warning.
      if(action==='adopt' && result.data?.adopted === true && validReview(result.data.review)) {
        adoptedRevision = {sessionId:session.sessionId,conversationId:conversation.id,identity:decisionIdentity(result.data.review)};
      }
      await refresh(true);
      if(action==='adopt') {activeConversationId=undefined;displayedConversation=undefined;selectedIndex=conversation.index;update();await openChange(conversation.index);}
    } finally {conversationBusy=false;update();}
  }

  async function previewConversationCandidate(conversation) {
    const candidate=conversation.candidate;
    if(!selected||!candidate?.id||!candidate.original||!candidate.preview)throw new Error('There is no suggested revision to inspect yet.');
    const original=candidate.original,proposed=candidate.preview,command=typeof original.command==='string';
    const before=command?original.command:original.after,after=command?proposed.command:proposed.after;
    if(typeof before!=='string'||typeof after!=='string')throw new Error('The suggested revision has no complete preview.');
    const snapshot={...review,id:conversation.reviewId,revision:conversation.revision,fingerprint:conversation.fingerprint};
    const filename=command?(/powershell/i.test(original.kind)?'command.ps1':'command.sh'):original.label;
    const left=makeDocument({...selected},snapshot,original,'candidate-original-'+candidate.id,before,filename);
    const right=makeDocument({...selected},snapshot,proposed,'candidate-proposed-'+candidate.id,after,filename);
    const leftDoc=await vscode.workspace.openTextDocument(left),rightDoc=await vscode.workspace.openTextDocument(right);
    const language=command?(/powershell/i.test(original.kind)?'powershell':'shellscript'):await languageFor(proposed,selected,rightDoc);
    if(language&&(await vscode.languages.getLanguages()).includes(language)){await vscode.languages.setTextDocumentLanguage(leftDoc,language);await vscode.languages.setTextDocumentLanguage(rightDoc,language);}
    await vscode.commands.executeCommand('vscode.diff',left,right,filename+' — Current proposal ↔ Suggested revision',{preview:true,preserveFocus:false,...(vscode.ViewColumn?{viewColumn:vscode.ViewColumn.Active}:{})});
    pruneSnapshots();
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
  register('pair.chatAction', input => openActionConversation(input));
  register('pair.chatSelection', () => openActionConversation(selectionTarget()));
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
  if(vscode.window.onDidChangeVisibleTextEditors)context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(()=>updateScopeDecoration(true)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { if (['file', SCHEME].includes(event.document.uri.scheme)) update(); }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(update));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === 'file') update(); pruneSnapshots(); }));
  const interval = setInterval(() => { void refresh().catch(error => { connected = false; errorMessage = error.message; update(); }); }, 1500);
  context.subscriptions.push({ dispose() { disposed = true; clearInterval(interval); documents.clear(); documentTargets.clear(); } });
  void refresh(true).catch(showError);
  return { getCommandViewState: () => commandCenter.getState(), getState: state, getConversationState: () => structuredClone({activeConversationId,conversation:activeConversation()}), conversationAction: handleConversationMessage, refresh: () => refresh(true) };
}

module.exports = { activate };
