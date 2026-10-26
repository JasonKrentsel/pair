'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture() {
  const root = path.resolve('checkpoint-fixture');
  const session = { version: 1, root, sessionId: 'checkpoint-session', port: 1, token: 'a'.repeat(64), pid: process.pid };
  const commands = new Map(), views = new Map(), requests = [], executed = [], warnings = [], webviewWrites = new Map();
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  let input = async () => 'Skip the full suite';
  let choice = async items => items[0];
  let memory = { revision: 0, constraints: [] };
  let review = null;
  const vscode = {
    EventEmitter: class { event = event; fire() {} dispose() {} },
    StatusBarAlignment: { Left: 1 },
    TreeItem: class {}, TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class {},
    commands: { registerCommand(name, fn) { commands.set(name, fn); return disposable(); }, executeCommand: async (...args) => { executed.push(args); } },
    workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }], textDocuments: [], isTrusted: true,
      getConfiguration() { return { get(_key, fallback) { return _key === 'openReviewAutomatically' ? false : fallback; } }; },
      registerTextDocumentContentProvider: disposable, onDidChangeWorkspaceFolders: event, onDidGrantWorkspaceTrust: event,
      onDidChangeTextDocument: event, onDidSaveTextDocument: event, onDidCloseTextDocument: event },
    window: { createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; }, createTreeView() { return disposable(); },
      registerWebviewViewProvider(id, provider) { views.set(id, provider); return disposable(); }, registerUriHandler: disposable,
      showWarningMessage: async message => { warnings.push(message); }, showInformationMessage: async () => {},
      showInputBox: async options => input(options), showQuickPick: async (items, options) => choice(items, options) },
  };
  const filename = path.resolve(__dirname, '../extension.cjs');
  const nativeRequire = createRequire(filename);
  const client = { ...nativeRequire('./client.cjs'), discoverSessions: async () => [session], request: async (_session, method, route, body) => {
    if (method === 'POST') {
      requests.push({ session: _session, route, body });
      assert.equal(route, '/memory');
      assert.equal(body.revision, memory.revision);
      memory = { ...memory, revision: memory.revision + 1, constraints: body.action === 'add_constraint'
        ? [...memory.constraints, { id: 'constraint-1', text: body.text, scope: body.scope, createdAt: '2026-10-26T00:00:00Z' }]
        : memory.constraints.filter(value => value.id !== body.id) };
      return { data: { accepted: true } };
    }
    return { data: { version: 1, sessionId: session.sessionId, root, review: structuredClone(review), memory: structuredClone(memory) }, etag: String(memory.revision) };
  } };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require(name) { return name === 'vscode' ? vscode : name === './client.cjs' ? client : nativeRequire(name); },
    setInterval: () => 1, clearInterval() {}, URLSearchParams, structuredClone, Date };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const context = { subscriptions: [] };
  const api = module.exports.activate(context);
  await api.refresh();
  for (const id of ['pair.review', 'pair.checkpoint']) {
    let html = '';
    const view = { webview: { options: {}, get html() { return html; }, set html(value) { html = value; webviewWrites.set(id, (webviewWrites.get(id) || 0) + 1); }, onDidReceiveMessage: event }, onDidDispose: event };
    views.get(id).resolveWebviewView(view);
  }
  return { api, commands, requests, executed, warnings, webviewWrites, vscode, setInput(fn) { input = fn; }, setChoice(fn) { choice = fn; },
    setMemory(value) { memory = value; }, setReview(value) { review = value; }, close() { for (const sub of context.subscriptions) sub.dispose(); } };
}

test('constraint commands send an exact scoped memory update, never an execution decision', async () => {
  const f = await fixture();
  try {
    f.setChoice(async items => items.find(item => item.scope === 'turn'));
    await f.commands.get('pair.addConstraint')();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].route, '/memory');
    assert.equal(f.requests[0].body.action, 'add_constraint');
    assert.equal(f.requests[0].body.revision, 0);
    assert.equal(f.requests[0].body.text, 'Skip the full suite');
    assert.equal(f.requests[0].body.scope, 'turn');
    f.setChoice(async items => items[0]);
    await f.commands.get('pair.removeConstraint')();
    assert.equal(f.requests[1].body.revision, 1);
    assert.equal(f.requests[1].body.action, 'remove_constraint');
    assert.equal(f.requests[1].body.id, 'constraint-1');
    assert.equal(f.api.getState().memory.constraints.length, 0);
    assert.ok(!f.executed.some(([name]) => name === 'vscode.diff'));
  } finally { f.close(); }
});

test('constraint input rejects a memory revision that changes while its dialog is open', async () => {
  const f = await fixture();
  try {
    f.setInput(async () => {
      f.setMemory({ revision: 1, constraints: [] });
      await f.api.refresh();
      return 'Do not install';
    });
    await assert.rejects(f.commands.get('pair.addConstraint')(), /changed while you were responding/);
    assert.equal(f.requests.length, 0);
    assert.ok(f.warnings.length);
  } finally { f.close(); }
});

test('untrusted workspaces and stale panel identities cannot mutate constraints', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.commands.get('pair.addConstraint')({ sessionId: 'another-session', revision: 0 }), /checkpoint or session changed/);
    f.vscode.workspace.isTrusted = false;
    await assert.rejects(f.commands.get('pair.addConstraint')(), /trusted matching Pi workspace/);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('checkpoint-only refresh repaints its panel without resetting the review or opening a diff', async () => {
  const f = await fixture();
  try {
    const reviewWrites = f.webviewWrites.get('pair.review');
    const checkpointWrites = f.webviewWrites.get('pair.checkpoint');
    f.setMemory({ revision: 1, constraints: [{ id: 'c', text: 'Explain first', scope: 'task', createdAt: '' }] });
    await f.api.refresh();
    assert.equal(f.webviewWrites.get('pair.review'), reviewWrites);
    assert.equal(f.webviewWrites.get('pair.checkpoint'), checkpointWrites + 1);
    await f.api.refresh();
    assert.equal(f.webviewWrites.get('pair.checkpoint'), checkpointWrites + 1, 'unchanged polling preserves checkpoint scroll and focus');
    assert.ok(!f.executed.some(([name]) => name === 'vscode.diff'));
  } finally { f.close(); }
});
