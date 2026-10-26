'use strict';
const { canonicalRoot, sameReview, identity } = require('./client.cjs');
const { newDraft, validText, textFor, sourceLines, isCurrentDraft, submissionFor, loadLocalState } = require('./feedback-model.cjs');
const { renderDesk, sidebarFeedback, scopedLabel, humanStatus } = require('./feedback-ui.cjs');

const STORAGE_KEY = 'pair.reviewDrafts.v1';
function createFeedbackController(vscode, context, options) {
  const stored = loadLocalState(context.workspaceState?.get(STORAGE_KEY));
  const documentInfo = new Map(), nativeThreads = new Map();
  let selectedThreadId, desk, deskSignature, busy = false, lastError = '', disposed = false;
  let persistence = Promise.resolve();
  const commentController = vscode.comments?.createCommentController('pair', 'Pair section review');
  if (commentController) {
    commentController.options = { prompt: 'Ask about this code or request a change. Save locally, then send the batch from Review Desk.', placeHolder: 'Feedback on these lines…' };
    commentController.commentingRangeProvider = { provideCommentingRanges(document) {
      const info = documentInfo.get(document.uri.toString()), current = options.getState();
      if (!info || info.scopeId !== current.feedback?.scopeId || !sameReview(current.review, identity(info.review)) || !current.review.pending || info.side === 'comparison') return [];
      const expected = textFor(info.review.changes[info.changeIndex], info.side);
      if (document.getText() !== expected) return [];
      return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    } };
    context.subscriptions.push(commentController);
  }
  const scopeKey = () => {
    const state = options.getState();
    return state.root && state.feedback?.scopeId ? canonicalRoot(state.root) + '\n' + state.feedback.scopeId : undefined;
  };
  function scope(create = false) {
    const key = scopeKey();
    if (!key) return undefined;
    let current = stored.scopes.find(value => value.key === key);
    if (!current && create) { current = { key, drafts: [] }; stored.scopes.push(current); stored.scopes.splice(0, Math.max(0, stored.scopes.length - 12)); }
    return current;
  }
  const drafts = () => scope()?.drafts || [];
  const renderedDrafts = () => drafts().map(draft => ({ ...draft, outdated: !isCurrentDraft(draft, options.getState().review) }));
  const threads = () => options.getState().feedback?.threads || [];
  const findItem = id => drafts().find(value => value.id === id) || threads().find(value => value.id === id);
  const persist = () => {
    const snapshot = structuredClone(stored);
    persistence = persistence.catch(() => {}).then(() => context.workspaceState?.update(STORAGE_KEY, snapshot));
    return persistence;
  };
  function changed() { sync(); options.onChanged(); }
  function ensureAvailable() {
    const state = options.getState();
    if (!state.feedback || !state.root) throw new Error('Connect to Pair 0.5 or later in this workspace to create section feedback.');
    return state;
  }
  function ensureMutable() {
    const state = ensureAvailable();
    if (!state.connected || !vscode.workspace.isTrusted || !options.matchesWorkspace()) throw new Error('Connect to a trusted matching Pi workspace before sending feedback.');
    if (busy) throw new Error('A feedback submission is already in progress.');
    return state;
  }
  function itemId(input) { return typeof input === 'string' ? input : input?.id || input?.pairId; }
  function assertionForDocument(uri, range) {
    const current = ensureAvailable();
    const info = uri && documentInfo.get(uri.toString());
    if (!info || info.scopeId !== current.feedback.scopeId || info.side === 'comparison' || !sameReview(current.review, identity(info.review)) || !current.review.pending) throw new Error('Select lines in the current pending Pair diff. Older snapshots remain read-only.');
    const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === uri.toString());
    const expected = textFor(info.review.changes[info.changeIndex], info.side);
    if (document && document.getText() !== expected) throw new Error('This snapshot was modified. Reopen the Pair diff before adding feedback.');
    const startLine = (range?.start.line ?? 0) + 1;
    const endLine = Math.max(startLine, (range?.end.line ?? range?.start.line ?? 0) + 1 - (range?.end.character === 0 && range.end.line > range.start.line ? 1 : 0));
    return { info, startLine, endLine, scopeId: current.feedback.scopeId };
  }
  async function addFeedback(intent, input) {
    const editor = vscode.window.activeTextEditor;
    const uri = input?.uri || input?.thread?.uri || editor?.document.uri;
    const range = input?.range || input?.thread?.range || editor?.selection;
    const target = assertionForDocument(uri, range);
    let text = input?.text;
    if (text === undefined) text = await vscode.window.showInputBox({ title: intent === 'ask' ? 'Ask about these lines' : 'Request a change to these lines', prompt: 'Save a local draft. Send all your comments together from Review Desk.', ignoreFocusOut: true,
      validateInput: value => !validText(value) ? 'Use 1–1,500 characters without terminal controls.' : undefined });
    if (text === undefined) return;
    const checked = assertionForDocument(uri, range);
    if (checked.scopeId !== target.scopeId || !sameReview(checked.info.review, identity(target.info.review))) throw new Error('The proposal changed while you were writing. Select its current code before saving feedback.');
    const local = scope(true);
    if (local.submission) throw new Error('Retry the pending feedback submission before changing its draft comments.');
    if (local.drafts.length >= 40) throw new Error('Review Desk holds up to 40 drafts per conversation. Remove old drafts before adding more.');
    const draft = newDraft(target.info.review, { changeIndex: target.info.changeIndex, side: target.info.side, startLine: target.startLine, endLine: target.endLine, intent, text });
    local.drafts.push(draft); selectedThreadId = draft.id;
    // VS Code creates a temporary empty thread for its gutter composer. Replace
    // that thread with the one bound to our durable local draft id.
    if (input?.thread && !input.thread.pairId) input.thread.dispose();
    await persist(); changed();
    return structuredClone(draft);
  }

  async function editDraft(input) {
    const id = itemId(input), local = scope(), draft = local?.drafts.find(value => value.id === id);
    if (!draft) throw new Error('That draft is no longer available in this conversation.');
    if (local.submission) throw new Error('Retry the pending feedback submission before editing its comments.');
    const key = local.key;
    const text = input?.text ?? await vscode.window.showInputBox({ title: 'Edit draft feedback', value: draft.text, ignoreFocusOut: true,
      validateInput: value => !validText(value) ? 'Use 1–1,500 characters without terminal controls.' : undefined });
    if (text === undefined) return;
    if (scope()?.key !== key || !scope().drafts.includes(draft)) throw new Error('The Pair conversation changed while you were writing.');
    if (!validText(text)) throw new Error('Use 1–1,500 characters without terminal controls.');
    draft.text = text.trim(); await persist(); changed();
  }
  async function removeDraft(input) {
    const id = itemId(input), local = scope();
    if (!local) return;
    if (local.submission) throw new Error('Retry the pending feedback submission before removing its comments.');
    local.drafts = local.drafts.filter(value => value.id !== id); await persist(); changed();
  }

  async function sendFeedback() {
    const state = ensureMutable();
    const local = scope(true), key = local.key, session = options.getSession();
    if (options.alteredSnapshots().length) throw new Error('A review snapshot was modified. Reopen its diff before submitting feedback.');
    const current = local.drafts.filter(draft => isCurrentDraft(draft, state.review));
    const payload = local.submission || submissionFor(state.review, current);
    local.submission = payload;
    // Persist the exact request before sending: an ambiguous response can be
    // retried with the same idempotency key after reconnect or editor reload.
    busy = true; lastError = ''; changed();
    try {
      await persist();
      if (scopeKey() !== key || options.getSession()?.sessionId !== session?.sessionId) throw new Error('The Pi conversation changed before feedback was sent.');
      await options.request(session, 'POST', '/feedback', payload);
      const ids = new Set(payload.comments.map(value => value.id));
      local.drafts = local.drafts.filter(value => !ids.has(value.id)); delete local.submission;
      await persist(); await options.refresh();
    } catch (error) {
      // A definite rejection may be edited; a timeout keeps the frozen payload.
      if (error.status && error.status >= 400 && error.status < 500) { delete local.submission; await persist(); }
      lastError = error.message;
      await options.refresh();
      if (scopeKey() === key && options.getState().feedback?.threads.some(thread => thread.batchId === payload.batchId)) { lastError = ''; return; }
      throw error;
    } finally { busy = false; changed(); }
  }
  async function addressFeedback(input) {
    const state = ensureMutable();
    const thread = threads().find(value => value.id === itemId(input));
    if (!thread) throw new Error('This feedback is no longer available. Refresh Review Desk.');
    const status = input?.status || (thread.status === 'addressed' ? 'open' : 'addressed');
    if (!['addressed', 'open'].includes(status)) throw new Error('Choose addressed or open.');
    if (input?.revision !== undefined && input.revision !== state.feedback.revision || input?.scopeId !== undefined && input.scopeId !== state.feedback.scopeId) throw new Error('Review state changed. Refresh before marking this feedback.');
    busy = true; lastError = ''; changed();
    try { await options.request(options.getSession(), 'POST', '/feedback-state', { revision: state.feedback.revision, threadId: thread.id, status }); await options.refresh(); }
    finally { busy = false; changed(); }
  }

  function reviewFor(item) {
    const state = options.getState();
    return sameReview(state.review, item) ? state.review : state.feedback?.reviews.find(value => sameReview(value, item));
  }
  async function openFeedback(input) {
    const item = findItem(itemId(input));
    if (!item) throw new Error('This feedback is no longer available in the selected conversation.');
    const before = reviewFor(item);
    if (!before) throw new Error('This old snapshot is no longer retained. Its saved excerpt remains in Review Desk.');
    selectedThreadId = item.id;
    const latest = input?.compare && item.latestReviewId ? options.getState().feedback?.reviews.find(value => value.id === item.latestReviewId) : undefined;
    if (input?.compare && !latest) throw new Error('No revised snapshot is available for this feedback yet.');
    await options.openSnapshot(before, item.changeIndex, { side: item.side, startLine: item.startLine, endLine: item.endLine, ...(latest ? { compare: latest } : {}) });
    sync();
    if (!input?.compare) for (const entry of nativeThreads.values()) if (entry.thread.pairId === item.id) entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  function safeMarkdown(text) {
    if (!vscode.MarkdownString) return String(text);
    const markdown = new vscode.MarkdownString(String(text)); markdown.isTrusted = false; markdown.supportHtml = false; markdown.supportThemeIcons = false; return markdown;
  }
  function nativeComment(text, author, label, pairId) {
    return { body: safeMarkdown(text), mode: vscode.CommentMode?.Preview ?? 0, author: { name: author }, label, contextValue: pairId ? 'pairDraftComment' : undefined, pairId };
  }
  function syncComments() {
    if (!commentController) return;
    const state = options.getState(), desired = new Map();
    for (const [uri, info] of documentInfo) {
      if (info.scopeId !== state.feedback?.scopeId || info.side === 'comparison') continue;
      const change = info.review.changes[info.changeIndex];
      const items = [...drafts(), ...threads()].filter(item => sameReview(info.review, item) && item.changeIndex === info.changeIndex && item.side === info.side);
      for (const item of items) {
        const key = uri + ':' + item.id;
        desired.set(key, { uri: info.uri, range: new vscode.Range(item.startLine - 1, 0, item.endLine - 1, 0), label: scopedLabel(item),
          comments: [nativeComment(item.text, 'You', `${item.intent === 'ask' ? 'Question' : 'Requested change'} · ${humanStatus(item.status)}`, item.status === 'draft' ? item.id : undefined), ...(item.reply ? [nativeComment(item.reply, 'Pi', undefined)] : [])],
          pairId: item.id, contextValue: item.status === 'draft' ? 'pairDraft' : 'pairSubmitted', state: item.status === 'addressed' ? vscode.CommentThreadState?.Resolved : vscode.CommentThreadState?.Unresolved });
      }
      if (info.side === 'proposed' && sameReview(state.review, identity(info.review))) {
        const explanation = change.why || info.review.why;
        const notes = [...(explanation ? [{ title: change.why ? 'Why this file changes' : 'Change overview · applies to the whole proposal', why: explanation, startLine: 1, endLine: 1 }] : []), ...(change.annotations || [])];
        for (const [index, note] of notes.entries()) {
          if (!Number.isInteger(note.startLine) || !Number.isInteger(note.endLine) || note.startLine < 1 || note.endLine > sourceLines(change.after).length || note.endLine < note.startLine) continue;
          desired.set(uri + ':explanation:' + index, { uri: info.uri, range: new vscode.Range(note.startLine - 1, 0, note.endLine - 1, 0), label: note.title || 'Why these lines?', comments: [nativeComment(note.why, 'Pi', 'Explanation')], contextValue: 'pairExplanation', expand: index === 0 });
        }
      }
    }
    for (const [key, entry] of nativeThreads) if (!desired.has(key)) { entry.thread.dispose(); nativeThreads.delete(key); }
    for (const [key, value] of desired) {
      const signature = JSON.stringify([value.label, value.comments.map(comment => [comment.body?.value ?? comment.body, comment.label]), value.state]);
      const existing = nativeThreads.get(key);
      if (existing?.signature === signature) continue;
      const thread = existing?.thread || commentController.createCommentThread(value.uri, value.range, value.comments);
      thread.label = value.label; thread.contextValue = value.contextValue; thread.pairId = value.pairId; thread.canReply = false;
      if (existing) thread.comments = value.comments;
      if (value.state !== undefined) thread.state = value.state;
      if (!existing) thread.collapsibleState = value.contextValue === 'pairDraft' || value.expand ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      nativeThreads.set(key, { signature, thread });
    }
  }

  function deskOptions() { const state = options.getState(); return { ...state, drafts: renderedDrafts(), threads: threads(), selectedId: selectedThreadId, trusted: vscode.workspace.isTrusted, busy, submission: scope()?.submission, errorMessage: lastError || state.connectionError || '' }; }
  function syncDesk(force = false, top = false) {
    if (!desk) return;
    const value = deskOptions();
    const signature = JSON.stringify([value.root, value.feedback?.scopeId, value.feedback?.revision, value.review?.id, value.review?.pending, value.drafts, value.selectedId, value.connected, value.trusted, value.busy, value.submission, value.errorMessage]);
    if (!force && signature === deskSignature) return;
    deskSignature = signature; desk.webview.html = renderDesk({ ...value, scrollTarget: top ? 'top' : undefined });
  }
  function sync() {
    if (disposed) return;
    const state = options.getState(), local = scope();
    // Reconcile a submission that succeeded before an editor reload or timeout.
    if (local?.submission && state.feedback?.threads.some(thread => thread.batchId === local.submission.batchId)) {
      const ids = new Set(local.submission.comments.map(comment => comment.id)); local.drafts = local.drafts.filter(draft => !ids.has(draft.id)); delete local.submission; void persist().catch(options.showError);
    }
    syncComments(); syncDesk();
    void vscode.commands.executeCommand('setContext', 'pair.hasDraftFeedback', renderedDrafts().some(draft => !draft.outdated)).then(undefined, () => {});
    void vscode.commands.executeCommand('setContext', 'pair.canSendFeedback', !!(state.connected && vscode.workspace.isTrusted && !busy && (scope()?.submission || state.review?.pending && drafts().some(draft => isCurrentDraft(draft, state.review))))).then(undefined, () => {});
  }
  async function openDesk() {
    if (desk) { desk.reveal(vscode.ViewColumn?.Active, false); syncDesk(); return; }
    if (!vscode.window.createWebviewPanel) throw new Error('This VS Code host cannot open Review Desk.');
    desk = vscode.window.createWebviewPanel('pair.reviewDesk', 'Pair Review Desk', vscode.ViewColumn?.Active ?? 1, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    desk.onDidDispose(() => { desk = undefined; deskSignature = undefined; }, undefined, context.subscriptions);
    desk.webview.onDidReceiveMessage(message => {
      if (!message || typeof message !== 'object') return;
      const state = options.getState();
      if (message.action === 'refresh') return void options.refresh().catch(options.showError);
      if (message.action === 'session') return void options.chooseSession?.().catch(options.showError);
      if (message.scopeId !== state.feedback?.scopeId) return options.showError(new Error('The Pi conversation changed. Reopen Review Desk.'));
      const run = async () => {
        if (message.action === 'select') { selectedThreadId = message.id; syncDesk(true, true); }
        else if (message.action === 'open' || message.action === 'compare') await openFeedback({ id: message.id, compare: message.action === 'compare' });
        else if (message.action === 'open-current' || message.action === 'open-file') {
          if (!sameReview(state.review, message.reviewIdentity)) throw new Error('The proposal changed. Open its current file list.');
          await options.openCurrent(message.action === 'open-file' ? Number(message.index) : undefined);
        }
        else if (message.action === 'send') {
          if (message.revision !== state.feedback?.revision) throw new Error('The review changed. Check the current feedback before sending.');
          await sendFeedback();
        }
        else if (message.action === 'remove') await removeDraft(message.id);
        else if (message.action === 'edit') await editDraft(message.id);
        else if (message.action === 'address') await addressFeedback({ ...message, status: threads().find(value => value.id === message.id)?.status === 'addressed' ? 'open' : 'addressed' });
        else if (message.action === 'followup') {
          await options.openCurrent();
          await vscode.window.showInformationMessage('Select the current lines and choose Ask or Request change. The original thread remains anchored to its exact snapshot.');
        }
      };
      void run().catch(options.showError);
    }, undefined, context.subscriptions);
    syncDesk(true);
  }
  function mapDocument(uri, review, changeIndex, side) {
    const scopeId = options.getState().feedback?.scopeId;
    const previous = documentInfo.get(uri.toString());
    if (previous && previous.scopeId === scopeId) return;
    const shared = [...documentInfo.values()].find(info => info.scopeId === scopeId && sameReview(review, identity(info.review)));
    documentInfo.set(uri.toString(), { uri, review: shared?.review || structuredClone(review), changeIndex, side, scopeId });
    syncComments();
  }
  function forgetDocument(uri) { documentInfo.delete(uri); syncComments(); }
  context.subscriptions.push({ dispose() { disposed = true; for (const entry of nativeThreads.values()) entry.thread.dispose(); nativeThreads.clear(); documentInfo.clear(); desk?.dispose(); } });
  return {
    sync, mapDocument, forgetDocument, addFeedback, editDraft, removeDraft, sendFeedback, addressFeedback, openFeedback, openDesk,
    sidebar: part => { const state = options.getState(); return sidebarFeedback({ drafts: renderedDrafts(), threads: threads(), supported: !!state.feedback, connected: state.connected && vscode.workspace.isTrusted, pending: !!state.review?.pending, busy, submission: scope()?.submission, part }); },
    blocksApproval: () => busy || !!scope()?.submission || drafts().some(draft => isCurrentDraft(draft, options.getState().review)),
    signature: () => JSON.stringify([scopeKey(), renderedDrafts(), threads(), busy, scope()?.submission]),
    getState: () => ({ scopeId: options.getState().feedback?.scopeId, drafts: structuredClone(renderedDrafts()), submission: scope()?.submission ? structuredClone(scope().submission) : undefined,
      selectedThreadId, commentThreadCount: nativeThreads.size, deskOpen: !!desk, busy,
      commentThreads: [...nativeThreads.values()].map(({ thread }) => ({ id: thread.pairId, label: thread.label, comments: thread.comments.map(comment => ({ body: comment.body?.value ?? comment.body, author: comment.author.name, label: comment.label })) })) }),
  };
}

module.exports = { createFeedbackController };
