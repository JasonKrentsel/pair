'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const proposal = () => ({ id: 'review-1', revision: 1, fingerprint: 'snapshot-1', gate: 1,
  title: 'Use the shared loader', why: 'Load the selected configuration consistently.', status: 'Awaiting permission', pending: true,
  changes: [{ kind: 'Edit', label: 'src/config.ts', before: 'old', after: 'new', why: 'Use the shared reader.' }] });

async function fixture() {
  const root = path.resolve('review-fixture');
  const session = { version: 1, root, sessionId: 'review-session', port: 1, token: 'a'.repeat(64), pid: process.pid };
  const commands = new Map(), views = new Map(), requests = [], executed = [], warnings = [];
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  let input = async () => 'Use the existing function instead';
  let review = null, progress = [], extra = {}, available = [session], htmlWrites = 0, messageHandler;
  const polls = [];
  const vscode = {
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1 },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return disposable(); }, executeCommand: async (...args) => { executed.push(args); } },
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], textDocuments: [], isTrusted: true,
      getConfiguration() { return { get(key, fallback) { return key === 'openReviewAutomatically' ? false : fallback; } }; },
      registerTextDocumentContentProvider: disposable, onDidChangeWorkspaceFolders: event, onDidGrantWorkspaceTrust: event,
      onDidChangeTextDocument: event, onDidSaveTextDocument: event, onDidCloseTextDocument: event },
    window: { createWebviewPanel() { return { webview: { html: '', onDidReceiveMessage: event, postMessage: async () => true }, onDidDispose: event, reveal() {}, dispose() {} }; }, createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider(id, provider) { views.set(id, provider); return disposable(); }, registerUriHandler: disposable,
      showWarningMessage: async message => { warnings.push(message); }, showInformationMessage: async () => {},
      showInputBox: async options => input(options), showQuickPick: async items => items[0] },
  };
  const filename = path.resolve(__dirname, '../extension.cjs');
  const nativeRequire = createRequire(filename);
  const client = { ...nativeRequire('./client.cjs'), discoverSessions: async () => available, request: async (target, method, route, body) => {
    if (method === 'POST') {
      requests.push({ session: target, route, body });
      assert.equal(route, '/decision');
      review = { ...review, pending: false, status: body.action === 'approve' ? 'Approved' : 'Denied' };
      return { data: { accepted: true } };
    }
    polls.push(target.sessionId);
    const live = available.find(value => value.sessionId === target.sessionId);
    if (!live) throw new Error('Old Pi listener closed');
    return { data: { version: 1, sessionId: live.sessionId, root, review: structuredClone(review), progress: structuredClone(progress), ...extra } };
  } };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require(name) { return name === 'vscode' ? vscode : name === './client.cjs' ? client : nativeRequire(name); },
    setInterval: () => 1, clearInterval() {}, URLSearchParams, structuredClone, Date };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const context = { subscriptions: [] };
  const api = module.exports.activate(context);
  await api.refresh();
  let html = '';
  const view = { webview: { options: {}, get html() { return html; }, set html(value) { html = value; htmlWrites++; }, onDidReceiveMessage(fn) { messageHandler = fn; return disposable(); } }, onDidDispose: event };
  views.get('pair.review').resolveWebviewView(view);
  return { session, polls, api, commands, views, requests, executed, warnings, vscode,
    get html() { return html; }, get htmlWrites() { return htmlWrites; }, send: message => messageHandler(message),
    setInput(fn) { input = fn; }, setSessions(values) { available = values; }, setExtra(value) { extra = value; },
    setReview(value) { review = value; }, setProgress(value) { progress = value; },
    close() { for (const sub of context.subscriptions) sub.dispose(); } };
}

test('only the step panel and core approval commands are registered', async t => {
  const f = await fixture(); t.after(f.close);
  assert.deepEqual([...f.views.keys()], ['pair.review']);
  for (const name of ['pair.reviewDesk','pair.checkpoint','pair.addConstraint','pair.sendQuestion','pair.addAskFeedback','pair.addRevisionFeedback']) assert.equal(f.commands.has(name), false, name);
  assert.equal(f.commands.has('pair.approve'), true);
  assert.equal(f.commands.has('pair.denyWithNote'), true);
  // Old Pi versions may still publish these fields; obsolete data must not block review.
  f.setExtra({ memory: { unsupported: true }, feedback: { unsupported: true } });
  f.setReview(proposal()); await f.api.refresh();
  assert.equal(f.api.getState().connected, true);
  assert.equal(f.api.getState().memory, undefined);
  assert.equal(f.api.getState().feedback, undefined);
});

test('approval posts only the exact current review decision', async t => {
  const f = await fixture(); t.after(f.close);
  const review = proposal(); f.setReview(review); await f.api.refresh();
  await f.commands.get('pair.approve')();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].body)), { reviewId: review.id, revision: 1, fingerprint: review.fingerprint, gate: 1, action: 'approve' });
  assert.equal(f.api.getState().review.pending, false);
  await assert.rejects(f.commands.get('pair.approve')(), /no longer pending/);
  assert.equal(f.requests.length, 1);
});

test('deny with note cancels safely and sends concise feedback only on submission', async t => {
  const f = await fixture(); t.after(f.close);
  f.setReview(proposal()); await f.api.refresh();
  f.setInput(async () => undefined);
  await f.commands.get('pair.denyWithNote')();
  assert.equal(f.requests.length, 0);
  f.setInput(async () => '  Use the existing reader.  ');
  await f.commands.get('pair.denyWithNote')();
  assert.equal(f.requests[0].body.action, 'deny');
  assert.equal(f.requests[0].body.note, 'Use the existing reader.');
});

test('review replacement during note entry prevents a decision for the old proposal', async t => {
  const f = await fixture(); t.after(f.close);
  f.setReview(proposal()); await f.api.refresh();
  f.setInput(async () => { f.setReview({ ...proposal(), gate: 2 }); await f.api.refresh(); return 'Different approach'; });
  await assert.rejects(f.commands.get('pair.denyWithNote')(), /review changed/);
  assert.equal(f.requests.length, 0);
});

test('untrusted workspaces, dirty target buffers, and old review gates cannot be approved', async t => {
  const f = await fixture(); t.after(f.close);
  f.setReview(proposal()); await f.api.refresh();
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.commands.get('pair.approve')(), /Trust this workspace/);
  f.vscode.workspace.isTrusted = true;
  f.vscode.workspace.textDocuments.push({ uri: { scheme: 'file', fsPath: path.join(f.session.root,'src/config.ts') }, isDirty: true });
  await assert.rejects(f.commands.get('pair.approve')(), /Save or discard/);
  f.vscode.workspace.textDocuments.length = 0;
  await assert.rejects(f.commands.get('pair.approve')({ reviewId: 'review-1', revision: 1, fingerprint: 'snapshot-1', gate: 2 }), /no longer pending/);
  assert.equal(f.requests.length, 0);
});

test('unchanged polling and output chunks do not rebuild the review panel', async t => {
  const f = await fixture(); t.after(f.close);
  const review = { ...proposal(), changes: [{ kind: 'bash', label: 'Run check', command: 'npm test', why: 'Verify this step.' }] };
  f.setReview(review); await f.api.refresh();
  const writes = f.htmlWrites;
  await f.api.refresh();
  f.setProgress([{reviewId: review.id,index: 0,status: 'Running',text: 'First output',truncated: false}]); await f.api.refresh();
  f.setProgress([{reviewId: review.id,index: 0,status: 'Running',text: 'First output\nSecond output',truncated: false}]); await f.api.refresh();
  assert.equal(f.htmlWrites, writes);
  assert.equal(f.requests.length, 0);
});

test('Pi reload reconnects to the sole replacement session without polling the retired listener', async t => {
  const f = await fixture(); t.after(f.close);
  const oldCount = f.polls.length;
  f.setSessions([{ ...f.session, sessionId: 'reloaded-session', port: 2 }]); await f.api.refresh();
  assert.equal(f.api.getState().connected, true);
  assert.equal(f.api.getState().sessionId, 'reloaded-session');
  assert.deepEqual(f.polls.slice(oldCount), ['reloaded-session']);
  assert.equal(f.requests.length, 0);
});

test('missing or ambiguous replacement sessions report a connection problem without choosing or approving', async t => {
  const f = await fixture(); t.after(f.close);
  f.setSessions([]); await f.api.refresh();
  assert.equal(f.api.getState().connected, false);
  assert.match(f.api.getState().connectionError, /disconnected/);
  f.setSessions([{ ...f.session, sessionId: 'one' }, { ...f.session, sessionId: 'two' }]); await f.api.refresh();
  assert.equal(f.api.getState().connected, false);
  assert.match(f.api.getState().connectionError, /Select the conversation/);
  assert.equal(f.requests.length, 0);
});

test('new reviews reset action selection and shortened reviews clamp it with automatic opening disabled', async t => {
  const f = await fixture(); t.after(f.close);
  const changes = [0,1,2].map(index => ({ kind: 'bash', label: 'Check ' + index, command: 'echo ' + index, why: 'Verify action ' + index }));
  const original = { ...proposal(), changes };
  f.setReview(original); await f.api.refresh();
  await f.commands.get('pair.openChange')(2);
  assert.match(f.html, /class="action selected" data-index="2"/);
  f.setReview({ ...original, revision: 2, fingerprint: 'shorter-snapshot', changes: changes.slice(0,2) }); await f.api.refresh();
  assert.match(f.html, /class="action selected" data-index="1"/);
  f.setReview({ ...original, id: 'new-review', fingerprint: 'new-snapshot' }); await f.api.refresh();
  assert.match(f.html, /class="action selected" data-index="0"/);
  assert.equal(f.api.getCommandViewState().reviewId, original.id, 'selection reset does not automatically open a new command');
  assert.equal(f.requests.length, 0);
});
