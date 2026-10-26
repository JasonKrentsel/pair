'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { canonicalRoot, containedFile, discoverSessions, validRegistry, request, identity, sameReview, validReview, validMemory, associatedLanguage } = require('../client.cjs');
const { renderCheckpointPanel } = require('../checkpoint-panel.cjs');

test('workspace identity handles Windows case and separators without matching siblings', () => {
  assert.equal(canonicalRoot('C:\\Users\\Jason\\Project\\', 'win32'), canonicalRoot('c:/users/jason/project', 'win32'));
  assert.notEqual(canonicalRoot('C:\\Project', 'win32'), canonicalRoot('C:\\Project-two', 'win32'));
});

test('affected-file resolution refuses files outside the workspace', () => {
  const root = path.resolve('fixture');
  assert.equal(containedFile(root, 'src/example.ts'), path.join(root, 'src/example.ts'));
  assert.equal(containedFile(root, '../outside.ts'), undefined);
  assert.equal(containedFile(root, '..'), undefined);
  assert.equal(containedFile(root, '\0file'), undefined);
});

test('session discovery excludes other workspaces, corrupt files and invalid network endpoints', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-client-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const session = { version: 1, sessionId: 'session-1234', root, port: 4321, token: 'a'.repeat(64), pid: process.pid };
  await fs.writeFile(path.join(directory, 'good.json'), JSON.stringify(session));
  await fs.writeFile(path.join(directory, 'other.json'), JSON.stringify({ ...session, root: path.join(directory, 'another') }));
  await fs.writeFile(path.join(directory, 'bad.json'), '{');
  await fs.writeFile(path.join(directory, 'invalid.json'), JSON.stringify({ ...session, port: -1 }));
  const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(finished, 'exit');
  await fs.writeFile(path.join(directory, 'dead.json'), JSON.stringify({ ...session, sessionId: 'dead-session', pid: finished.pid }));
  assert.deepEqual(await discoverSessions([root], directory), [session]);
  assert.equal(validRegistry({ ...session, token: 'unsafe\r\nvalue' }), false);
});

test('client sends bearer-authenticated loopback requests and supports ETags', async t => {
  const observed = [];
  const server = http.createServer((req, res) => {
    observed.push({ url: req.url, auth: req.headers.authorization, etag: req.headers['if-none-match'] });
    if (req.headers['if-none-match'] === 'revision-1') { res.writeHead(304); res.end(); return; }
    if (req.url === '/decision') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'This proposal changed.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: 'revision-1' }); res.end(JSON.stringify({ review: null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const session = { version: 1, sessionId: 'session-1234', root: process.cwd(), port: server.address().port, token: 'b'.repeat(64), pid: process.pid };
  assert.deepEqual((await request(session)).data, { review: null });
  assert.equal((await request(session, 'GET', '/review', undefined, 'revision-1')).unchanged, true);
  await assert.rejects(request(session, 'POST', '/decision', { action: 'approve' }), error => error.status === 409 && error.message === 'This proposal changed.');
  assert.equal(observed[0].auth, `Bearer ${session.token}`);
  assert.equal(observed[1].etag, 'revision-1');
});

test('review identities reject replacing a review or revision during user input', () => {
  const review = { id: 'review-1', revision: 1, fingerprint: 'hash-1', title: 'Change', why: 'Reason', status: 'Awaiting permission', pending: true, changes: [{ label: 'src/a.ts', kind: 'Edit', before: 'old', after: 'new' }] };
  assert.equal(validReview(review), true);
  assert.equal(validReview({ ...review, changes: [{ label: 'x', kind: 'Edit', before: 2 }] }), false);
  const expected = identity(review);
  assert.equal(sameReview(review, expected), true);
  for (const changed of [{ id: 'review-2' }, { revision: 2 }, { fingerprint: 'hash-2' }]) assert.equal(sameReview({ ...review, ...changed }, expected), false);
});

test('new-file language selection honors configured basename and relative path associations', () => {
  const root = path.resolve('workspace');
  assert.equal(associatedLanguage({ '*.custom': 'typescript' }, path.join(root, 'src/a.custom'), root), 'typescript');
  assert.equal(associatedLanguage({ '*.custom': 'plaintext', 'src/*.custom': 'javascript' }, path.join(root, 'src/a.custom'), root), 'javascript');
  assert.equal(associatedLanguage({ '**/*.view': 'html' }, path.join(root, 'src/nested/a.view'), root), 'html');
  assert.equal(associatedLanguage({ Dockerfile: 'dockerfile' }, path.join(root, 'Dockerfile'), root), 'dockerfile');
  assert.equal(associatedLanguage({ '*.custom': 'typescript' }, path.join(root, 'src/a.ts'), root), undefined);
  assert.equal(associatedLanguage({ '*.ts': 'plaintext' }, path.join(root, 'src/a.ts'), root), 'plaintext');
});

test('checkpoint memory validates bounded fields and unique human constraints', () => {
  const empty = { revision: 0, constraints: [] };
  assert.equal(validMemory(empty), true);
  assert.equal(validMemory(undefined), false, 'legacy absence is handled by the caller, not invented as live data');
  const checkpoint = { objective: 'Resume a run', implemented: 'Checkpoint writes', verification: 'Focused tests pass', usable: 'Internal API only', deferred: 'CLI wiring', next: 'Read a saved run', revision: 1, updatedAt: '2026-10-26T00:00:00Z', stale: false };
  const constraint = { id: 'human-1', text: 'Skip the full suite', scope: 'task', createdAt: '2026-10-26T00:00:00Z' };
  const memory = { revision: 2, checkpoint, constraints: [constraint] };
  assert.equal(validMemory(memory), true);
  assert.equal(validMemory({ ...memory, revision: -1 }), false);
  assert.equal(validMemory({ ...memory, checkpoint: { ...checkpoint, objective: 'x'.repeat(241) } }), false);
  assert.equal(validMemory({ ...memory, checkpoint: { ...checkpoint, stale: 'false' } }), false);
  assert.equal(validMemory({ ...memory, checkpoint: { ...checkpoint, next: undefined } }), false);
  assert.equal(validMemory({ ...memory, constraints: [constraint, constraint] }), false);
  assert.equal(validMemory({ ...memory, constraints: [{ ...constraint, scope: 'forever' }] }), false);
  assert.equal(validMemory({ ...memory, constraints: [{ ...constraint, text: 'x'.repeat(301) }] }), false);
  assert.equal(validMemory({ ...memory, constraints: [{ ...constraint, scope: 'turn', pendingTurn: true }] }), true);
  assert.equal(validMemory({ ...memory, constraints: [{ ...constraint, scope: 'task', pendingTurn: true }] }), false);
  assert.equal(validMemory({ ...memory, constraints: [{ ...constraint, pendingTurn: 'yes' }] }), false);
});

test('checkpoint panel distinguishes claims, stale verification, scope and safe text', () => {
  const memory = { revision: 4, checkpoint: { objective: '<script>bad()</script>', implemented: 'Saved data', verification: 'Tests passed', usable: 'Internal API', deferred: 'CLI', next: 'Resume', revision: 2, updatedAt: '2026-10-26T00:00:00Z', stale: true },
    constraints: [{ id: 'c1', text: 'No installation <please>', scope: 'turn', createdAt: '' }] };
  const html = renderCheckpointPanel({ memory, sessionId: 'session-1', connected: true, trusted: true, busy: false, pending: true });
  assert.match(html, /Verification · agent report/);
  assert.match(html, /Verification needs a fresh report/);
  assert.match(html, /Usable now/);
  assert.match(html, /This turn/);
  assert.match(html, /next human chat message/);
  assert.match(html, /No installation &lt;please&gt;/);
  assert.ok(!html.includes('<script>bad()</script>'));
  assert.match(html, /grant no permission to execute/);
  assert.match(html, /Changing constraints cancels the pending review/);
  assert.match(html, /"sessionId":"session-1","revision":4/);
  const unknown = renderCheckpointPanel({ connected: true, trusted: true });
  assert.match(unknown, /does not provide checkpoint data yet/);
  assert.equal((unknown.match(/Not recorded/g) || []).length, 6);
  assert.match(unknown, /data-action="add" disabled/);
  const disconnected = renderCheckpointPanel({ memory, sessionId: 'session-1', connected: false, trusted: true });
  assert.match(disconnected, /data-action="remove" disabled/);
  const queued = renderCheckpointPanel({ memory: { ...memory, constraints: [{ ...memory.constraints[0], pendingTurn: true }] }, sessionId: 'session-1', connected: true, trusted: true });
  assert.match(queued, /<span class="scope">Next turn<\/span>/);
});
