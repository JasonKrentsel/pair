'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { anchorFor, newDraft, submissionFor, loadLocalState, validFeedback } = require('../feedback-model.cjs');
const { markdown, renderDesk, submissionLabel, submissionEffect } = require('../feedback-ui.cjs');
const { createFeedbackController } = require('../feedback-controller.cjs');

const proposal = (overrides = {}) => ({ id: 'review-one', revision: 1, fingerprint: 'a'.repeat(64), pending: true, title: 'Share answer validation', why: 'Reject incomplete results before returning them.', status: 'Awaiting permission',
  changes: [{ label: 'src/answer.ts', kind: 'write', before: '', after: 'export function answer(text: string) {\n  return text.trim();\n}\n', why: 'Keep **validation** in one place.', annotations: [{ title: 'Normalize the reply', why: 'Use `trim()` before returning.', startLine: 2, endLine: 2 }] },
    { label: 'src/index.ts', kind: 'edit', before: 'return text;\n', after: 'return answer(text);\n' }], ...overrides });

function fixture(saved) {
  const storage = saved || new Map(), requests = [], opened = [], native = [], panels = [], subscriptions = [];
  const state = { root: path.resolve('feedback-project'), connected: true, review: proposal(), feedback: { version: 1, revision: 0, scopeId: 'pi-conversation', threads: [], reviews: [] } };
  state.feedback.reviews.push({ ...structuredClone(state.review), pending: false, createdAt: new Date().toISOString() });
  let session = { sessionId: 'bridge-one' }, transport = async () => ({}), refreshes = 0;
  const disposable = () => ({ dispose() {} });
  class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class MarkdownString { constructor(value) { this.value = value; } }
  const commentController = { dispose() {}, createCommentThread(uri, range, comments) { const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } }; native.push(thread); return thread; } };
  const vscode = { Range, MarkdownString, CommentMode: { Preview: 0 }, CommentThreadState: { Resolved: 1, Unresolved: 0 }, CommentThreadCollapsibleState: { Expanded: 1, Collapsed: 0 }, ViewColumn: { Active: -1, Beside: -2 },
    comments: { createCommentController() { return commentController; } }, commands: { executeCommand: async () => {} }, workspace: { isTrusted: true, textDocuments: [] },
    window: { showInformationMessage: async () => {}, showInputBox: async () => undefined, createWebviewPanel(type, title, column, options) {
      const panel = { type, title, column, options, writes: 0, reveal() {}, dispose() {}, onDidDispose: disposable,
        webview: { set html(value) { panel.html = value; panel.writes++; }, onDidReceiveMessage(fn) { panel.receive = fn; return disposable(); } } };
      panels.push(panel); return panel;
    } } };
  const context = { subscriptions, workspaceState: { get: key => storage.get(key), update: async (key, value) => storage.set(key, structuredClone(value)) } };
  const controller = createFeedbackController(vscode, context, { getState: () => state, getSession: () => session, matchesWorkspace: () => true, alteredSnapshots: () => [],
    request: async (...args) => { requests.push(structuredClone(args)); return transport(...args); }, refresh: async () => { refreshes++; controller.sync(); }, onChanged() {},
    openSnapshot: async (...args) => opened.push(args), openCurrent: async () => opened.push('current'), showError(error) { throw error; } });
  const makeDocument = (review = state.review, index = 0, side = 'proposed') => {
    const uri = { toString: () => `pair-review://${session.sessionId}/${review.id}/${side}/${review.changes[index].label}` };
    let content = side === 'before' ? review.changes[index].before : side === 'proposed' ? review.changes[index].after : review.changes[index].command;
    const document = { uri, getText: () => content, lineCount: content.split('\n').length };
    vscode.workspace.textDocuments.push(document); controller.mapDocument(uri, review, index, side);
    return { uri, document, range: new Range(1, 0, 1, 20), modify(value) { content = value; } };
  };
  const f = { controller, storage, state, requests, opened, native, panels, vscode, commentController, makeDocument, setTransport(fn) { transport = fn; }, setSession(value) { session = value; },
    get refreshes() { return refreshes; }, close() { subscriptions.forEach(value => value.dispose()); } };
  return f;
}

test('exact anchors and batches are bounded and contain no entire snapshot or repeated rationale', () => {
  const review = proposal();
  const anchor = anchorFor(review, 0, 'proposed', 2, 2);
  assert.equal(anchor.excerpt, '  return text.trim();');
  assert.equal(anchor.snapshotHash.length, 64);
  const draft = newDraft(review, { changeIndex: 0, side: 'proposed', startLine: 2, endLine: 2, intent: 'ask', text: 'Why trim here?' });
  const body = submissionFor(review, [draft]);
  assert.deepEqual(Object.keys(body.comments[0]).sort(), ['changeIndex', 'endLine', 'id', 'intent', 'side', 'startLine', 'text']);
  assert.equal(body.reviewId, review.id);
  assert.throws(() => anchorFor(review, 0, 'proposed', 0, 2), /Select between/);
  assert.throws(() => anchorFor(review, 0, 'command', 1, 1), /no source snapshot/);
  assert.throws(() => submissionFor(proposal({ revision: 2 }), [draft]), /older proposal/);
  assert.throws(() => submissionFor(review, Array(11).fill(draft)), /1 and 10/);
  assert.throws(() => newDraft(review, { ...draft, text: 'hi\u001b[31m' }), /terminal controls/);
});

test('local drafts, navigation, note edits and diff selection make no network requests', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument();
    const draft = await f.controller.addFeedback('ask', { ...doc, text: 'Why use `trim()`?' });
    assert.equal(draft.startLine, 2);
    assert.equal(f.controller.blocksApproval(), true);
    await f.controller.openDesk();
    assert.equal(f.panels[0].column, f.vscode.ViewColumn.Active, 'desk uses the active group, not a right-hand group');
    await f.controller.openFeedback({ id: draft.id });
    await f.controller.editDraft({ id: draft.id, text: 'Why normalize before validation?' });
    assert.equal(f.controller.getState().selectedThreadId, draft.id);
    const writes = f.panels[0].writes, thread = f.native.find(value => value.pairId === draft.id);
    f.controller.sync(); f.controller.sync();
    assert.equal(f.panels[0].writes, writes, 'unchanged polling leaves view and scroll state intact');
    assert.equal(f.native.find(value => value.pairId === draft.id), thread, 'unchanged comments keep their native thread identity');
    assert.equal(thread.comments[0].body.isTrusted, false);
    assert.equal(thread.comments[0].body.supportHtml, false);
    assert.match(thread.comments[0].label, /Question · Draft · not sent/);
    assert.equal(f.requests.length, 0);
    await f.controller.removeDraft(draft.id);
    assert.equal(f.controller.blocksApproval(), false);
  } finally { f.close(); }
});

test('native gutter composer converts to a persisted local thread and multi-line selections normalize their end', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument();
    const composer = { uri: doc.uri, range: new f.vscode.Range(0, 0, 2, 0), dispose() { this.disposed = true; } };
    const draft = await f.controller.addFeedback('revise', { thread: composer, text: 'Validate first.' });
    assert.equal(composer.disposed, true);
    assert.equal(draft.startLine, 1); assert.equal(draft.endLine, 2);
    assert.ok(f.native.some(value => value.pairId === draft.id && !value.disposed));
    assert.equal(f.commentController.commentingRangeProvider.provideCommentingRanges(doc.document).length, 1);
  } finally { f.close(); }
});

test('drafts survive editor reload and bridge rotation but remain isolated from other Pi conversations', async () => {
  const f = fixture();
  const draft = await f.controller.addFeedback('revise', { ...f.makeDocument(), text: 'Guard empty replies.' });
  f.close();
  const g = fixture(f.storage);
  try {
    g.setSession({ sessionId: 'new-bridge-same-conversation' });
    g.makeDocument();
    assert.equal(g.controller.getState().drafts[0].id, draft.id);
    assert.equal(g.controller.blocksApproval(), true);
    g.state.feedback.scopeId = 'other-conversation'; g.controller.sync();
    assert.deepEqual(g.controller.getState().drafts, []);
    assert.equal(g.controller.blocksApproval(), false);
    g.state.feedback.scopeId = 'pi-conversation'; g.state.review = proposal({ id: 'review-two', revision: 2 }); g.controller.sync();
    assert.equal(g.controller.getState().drafts[0].outdated, true);
    await assert.rejects(g.controller.sendFeedback(), /1 and 10/);
    assert.equal(g.requests.length, 0);
  } finally { g.close(); }
});

test('stale review identities and modified virtual snapshots cannot produce feedback', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument(); doc.modify('externally edited snapshot');
    await assert.rejects(f.controller.addFeedback('ask', { ...doc, text: 'Why?' }), /snapshot was modified/);
    assert.deepEqual(f.commentController.commentingRangeProvider.provideCommentingRanges(doc.document), []);
    f.state.review = proposal({ fingerprint: 'b'.repeat(64) });
    await assert.rejects(f.controller.addFeedback('ask', { ...doc, text: 'Why?' }), /current pending Pair diff/);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('only the current proposal contributes explanation threads; archived human anchors remain', async () => {
  const f = fixture();
  try {
    const draft = await f.controller.addFeedback('revise', { ...f.makeDocument(), text: 'Validate empty strings.' });
    assert.equal(f.native.filter(thread => !thread.disposed && thread.contextValue === 'pairExplanation').length, 1);
    f.state.review = proposal({ id: 'next-review', revision: 2, fingerprint: 'b'.repeat(64) }); f.controller.sync();
    assert.equal(f.native.filter(thread => !thread.disposed && thread.contextValue === 'pairExplanation').length, 0);
    assert.ok(f.native.some(thread => !thread.disposed && thread.pairId === draft.id));
    assert.match(f.native.find(thread => thread.pairId === draft.id).comments[0].label, /Requested change/);
  } finally { f.close(); }
});

test('one submission sends all current drafts exactly once and freezes a retry after an ambiguous response', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument();
    await f.controller.addFeedback('ask', { ...doc, text: 'Why trim?' });
    await f.controller.addFeedback('revise', { ...f.makeDocument(f.state.review, 1), range: new f.vscode.Range(0, 0, 0, 5), text: 'Keep the call explicit.' });
    let rejectRequest;
    f.setTransport(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const first = f.controller.sendFeedback();
    await assert.rejects(f.controller.sendFeedback(), /already in progress/);
    while (!rejectRequest) await new Promise(resolve => setImmediate(resolve));
    rejectRequest(new Error('Timed out after submission'));
    await assert.rejects(first, /Timed out/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0][2], '/feedback');
    assert.equal(f.requests[0][3].comments.length, 2);
    await assert.rejects(f.controller.editDraft({ id: f.controller.getState().drafts[0].id, text: 'Changed' }), /pending feedback/);
    const frozen = f.controller.getState().submission;
    f.setTransport(async () => ({}));
    await f.controller.sendFeedback();
    assert.deepEqual(f.requests[1][3], frozen, 'retry reuses the identical batch and comments');
    assert.equal(f.controller.getState().drafts.length, 0);
    assert.equal(f.controller.getState().submission, undefined);
  } finally { f.close(); }
});

test('submitted anchors remain inspectable; since-feedback requires explicit lineage; addressed is not approval', async () => {
  const f = fixture();
  try {
    const draft = await f.controller.addFeedback('ask', { ...f.makeDocument(), text: 'Why trim?' });
    await f.controller.removeDraft(draft.id);
    f.state.feedback.threads = [{ ...draft, status: 'answered', batchId: 'batch-one', reply: 'Whitespace-only responses are empty after normalization.' }];
    f.state.review.pending = false; f.controller.sync();
    await f.controller.openFeedback(draft.id);
    assert.equal(f.opened[0][0].id, draft.reviewId);
    await assert.rejects(f.controller.openFeedback({ id: draft.id, compare: true }), /No revised snapshot/);
    const revised = proposal({ id: 'review-two', revision: 2, fingerprint: 'b'.repeat(64) });
    f.state.feedback.reviews.push({ ...revised, pending: false });
    f.state.feedback.threads[0].latestReviewId = revised.id; f.state.feedback.threads[0].status = 'revision-ready';
    await f.controller.openFeedback({ id: draft.id, compare: true });
    assert.equal(f.opened[1][2].compare.id, revised.id);
    await f.controller.addressFeedback({ id: draft.id, status: 'addressed' });
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0][2], '/feedback-state');
    assert.deepEqual(f.requests[0][3], { revision: 0, threadId: draft.id, status: 'addressed' });
    await assert.rejects(f.controller.addressFeedback({ id: draft.id, revision: 3 }), /Review state changed/);
  } finally { f.close(); }
});

test('webview Markdown escapes HTML and keeps command links inert while showing code and lists', () => {
  const text = '<img src=x onerror=alert(1)>\n[execute](command:evil)\n- **Reason** with `code()`\n```ts\nconst x = "</script>";\n```';
  const html = markdown(text);
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('href=')); assert.ok(!html.includes('</script>'));
  assert.match(html, /&lt;img/); assert.match(html, /<ul>/); assert.match(html, /<strong>Reason<\/strong>/); assert.match(html, /<code>code\(\)<\/code>/);
  const draft = newDraft(proposal(), { changeIndex: 0, side: 'proposed', startLine: 2, endLine: 2, intent: 'ask', text });
  const htmlDesk = renderDesk({ drafts: [draft], review: proposal(), feedback: { version: 1, revision: 0, scopeId: 'scope', reviews: [] }, connected: true, trusted: true });
  assert.ok(!htmlDesk.includes('<img')); assert.match(htmlDesk, /default-src 'none'/); assert.match(htmlDesk, /Drafts · 1/);
  assert.match(htmlDesk, /scrollY/); assert.match(htmlDesk, /They do not deny the step or request changes/);
});

test('saved local state and protocol reject malformed drafts, ranges and annotations safely', () => {
  const state = { version: 1, revision: 0, scopeId: 'scope', reviews: [{ ...proposal(), pending: false }], threads: [] };
  assert.equal(validFeedback(state), true);
  assert.equal(validFeedback({ ...state, reviews: [{ ...proposal(), changes: [{ ...proposal().changes[0], annotations: {} }] }] }), false);
  const draft = newDraft(proposal(), { changeIndex: 0, side: 'proposed', startLine: 1, endLine: 1, intent: 'ask', text: 'Why?' });
  const restored = loadLocalState({ version: 1, scopes: [{ key: 'scope', drafts: [{ ...draft, startLine: -1 }, draft], submission: { batchId: 'bad', comments: [] } }] });
  assert.equal(restored.scopes[0].drafts.length, 1); assert.equal(restored.scopes[0].submission, undefined);
});

test('Review Desk shows the proposal before any comments and distinguishes completed and disconnected states', () => {
  const review = proposal();
  const options = { review, feedback: { version: 1, revision: 0, scopeId: 'scope', reviews: [], threads: [] }, connected: true, trusted: true };
  const pending = renderDesk(options);
  assert.match(pending, /Ready for your review/);
  assert.match(pending, /Files in this step/);
  assert.match(pending, /data-action="open-file" data-index="0"/);
  assert.match(pending, /layout overview/);
  assert.ok(!pending.includes('Send 0 draft comments'));
  const done = renderDesk({ ...options, review: { ...review, pending: false, status: 'Applied' } });
  assert.match(done, /Latest step · Applied/);
  assert.match(done, /before approving it/);
  const disconnected = renderDesk({ ...options, connected: false, errorMessage: 'Pi listener closed' });
  assert.match(disconnected, /Pi listener closed/);
  assert.match(disconnected, /data-action="refresh">Reconnect/);
});

test('general file rationale does not insert an expanded comment at line one',()=>{
 const f=fixture();try{delete f.state.review.changes[0].annotations;f.makeDocument(f.state.review,0,'proposed');assert.equal(f.native.filter(t=>t.contextValue==='pairExplanation').length,0);}finally{f.close();}
});

test('sending one inline question preserves other drafts and retries the exact question', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument();
    const question = await f.controller.addFeedback('ask', { ...doc, text: 'Why normalize?' });
    const revision = await f.controller.addFeedback('revise', { ...doc, text: 'Keep the caller name.' });
    const questionThread = f.native.find(thread => thread.pairId === question.id);
    assert.equal(questionThread.contextValue, 'pairDraftQuestion');
    f.setTransport(async () => { throw new Error('Question timed out'); });
    await assert.rejects(f.controller.sendQuestion(questionThread), /timed out/);
    assert.deepEqual(f.requests[0][3].comments.map(comment => comment.id), [question.id]);
    f.state.review = { ...f.state.review, pending: false, status: 'Answering questions' };
    f.controller.sync();
    assert.equal(questionThread.contextValue, 'pairDraftQuestion', 'uncertain submission remains retryable inline after Pi accepted the question');
    const first = structuredClone(f.requests[0][3]);
    f.setTransport(async () => ({}));
    await f.controller.sendQuestion(questionThread);
    assert.deepEqual(f.requests[1][3], first);
    assert.deepEqual(f.controller.getState().drafts.map(draft => draft.id), [revision.id]);
    await assert.rejects(f.controller.sendQuestion(revision.id), /question draft/);
    assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

test('questions and new answers expand inline once while waiting drafts retain their exact identity', async () => {
  const f = fixture();
  try {
    const doc = f.makeDocument();
    const question = await f.controller.addFeedback('ask', { ...doc, text: 'Why normalize?' });
    const other = await f.controller.addFeedback('revise', { ...doc, text: 'Keep the caller name.' });
    await f.controller.removeDraft(question.id);
    f.state.review = { ...f.state.review, pending: false, status: 'Answering questions' };
    f.state.feedback.threads = [{ ...question, status: 'submitted', batchId: 'question-batch' }];
    f.controller.sync();
    const thread = f.native.find(value => !value.disposed && value.pairId === question.id);
    assert.equal(thread.collapsibleState, f.vscode.CommentThreadCollapsibleState.Expanded);
    assert.equal(f.controller.getState().drafts.find(draft => draft.id === other.id).outdated, false);
    thread.collapsibleState = f.vscode.CommentThreadCollapsibleState.Collapsed;
    f.controller.sync();
    assert.equal(thread.collapsibleState, f.vscode.CommentThreadCollapsibleState.Collapsed);
    f.state.feedback.threads[0].reply = 'Whitespace-only values become empty.';
    f.state.feedback.threads[0].status = 'answered';
    f.controller.sync();
    assert.equal(thread.collapsibleState, f.vscode.CommentThreadCollapsibleState.Expanded);
    assert.equal(thread.comments[1].body.value, 'Whitespace-only values become empty.');
    thread.collapsibleState = f.vscode.CommentThreadCollapsibleState.Collapsed;
    f.controller.sync();
    assert.equal(thread.collapsibleState, f.vscode.CommentThreadCollapsibleState.Collapsed);
    assert.equal(f.requests.length, 0, 'rendering questions and replies never calls a model');
  } finally { f.close(); }
});

test('question states and intent labels explain approval without calling a paused step complete', () => {
  const question = newDraft(proposal(), { changeIndex: 0, side: 'proposed', startLine: 2, endLine: 2, intent: 'ask', text: 'Why trim?' });
  assert.equal(submissionLabel([question]), 'Send question');
  assert.equal(submissionLabel([{ intent: 'revise' }]), 'Request revision');
  assert.match(submissionEffect([question, { intent: 'revise' }]), /needs revision before approval/);
  const options = { drafts: [question], review: proposal({ pending: false, status: 'Answering questions' }), feedback: { revision: 0, scopeId: 'scope', reviews: [] }, connected: true, trusted: true };
  const waiting = renderDesk(options);
  assert.match(waiting, /step is unchanged/);
  assert.doesNotMatch(waiting, /step is complete|Latest step/);
  assert.match(waiting, /data-action="send-question"[^>]*disabled/);
  assert.ok(waiting.indexOf('Your question') < waiting.indexOf('<summary>Selected code'));
  assert.match(renderDesk({ ...options, review: proposal({ status: 'Ready to approve' }) }), /use Approve step when ready/);
  assert.match(renderDesk({ ...options, review: proposal({ pending: false, status: 'Revision requested' }) }), /approve the revised step/);
});

test('mixed step overview keeps files and commands in execution order with individual explanations', () => {
  const review = proposal();
  review.changes.splice(1, 0, { label: 'npm run check', kind: 'bash', command: 'npm run check', cwd: 'C:/project', why: 'Verify the new module before updating the caller.' });
  const html = renderDesk({ review, feedback: { revision: 0, scopeId: 'scope', reviews: [] }, connected: true, trusted: true });
  assert.match(html, /Actions in execution order/);
  assert.ok(html.indexOf('1. src/answer.ts') < html.indexOf('2. bash command'));
  assert.ok(html.indexOf('2. bash command') < html.indexOf('3. src/index.ts'));
  assert.match(html, /<code>npm run check<\/code>/);
  assert.match(html, /Verify the new module before updating the caller/);
});

test('command snapshots expose anchored explanations and support inline questions without a proposed file', async () => {
  const f = fixture();
  try {
    f.state.review.changes = [{ label: 'npm run check', kind: 'bash', command: 'npm run check\nnpm run lint', why: 'Check types and style before packaging.', annotations: [{ title: 'Check style', why: 'Lint runs only after type checking.', startLine: 2, endLine: 2 }] }];
    const doc = f.makeDocument(f.state.review, 0, 'command');
    const explanations = f.native.filter(thread => thread.contextValue === 'pairExplanation');
    assert.equal(explanations.length, 1);
    assert.equal(explanations[0].label, 'Check style');
    assert.equal(explanations[0].range.start.line, 1);
    assert.equal(explanations[0].collapsibleState, f.vscode.CommentThreadCollapsibleState.Collapsed);
    const draft = await f.controller.addFeedback('ask', { ...doc, text: 'Why both checks?' });
    assert.equal(draft.side, 'command');
    assert.equal(draft.excerpt, 'npm run lint');
    assert.equal(f.requests.length, 0);
    await f.controller.sendQuestion(draft.id);
    assert.equal(f.requests[0][3].comments[0].side, 'command');
    assert.equal(f.requests[0][3].comments[0].startLine, 2);
  } finally { f.close(); }
});

test('section explanations trim blank edges, combine duplicate anchors and remain collapsed',()=>{
 const f=fixture();try{
  const change=f.state.review.changes[0];change.after='\nfunction run() {\n\n  return 1;\n\n}\n';
  change.annotations=[{title:'Return',why:'Use one.',startLine:3,endLine:5},{title:'Same section',why:'Keep this explicit.',startLine:4,endLine:4},{title:'Blank',why:'Skip',startLine:1,endLine:1}];
  f.makeDocument(f.state.review,0,'proposed');const notes=f.native.filter(t=>t.contextValue==='pairExplanation');
  assert.equal(notes.length,1);assert.equal(notes[0].range.start.line,3);assert.equal(notes[0].range.start.character,2);assert.equal(notes[0].range.end.character,11);assert.equal(notes[0].comments.length,2);assert.equal(notes[0].collapsibleState,0);
 }finally{f.close();}
});
