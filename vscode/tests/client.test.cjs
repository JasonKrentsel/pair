'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { canonicalRoot, containedFile, discoverSessions, validRegistry, request, identity, sameReview, validReview, associatedLanguage } = require('../client.cjs');

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

// Decisions must match both the exact snapshot and its current permission gate.
test('review gates reject delayed approval identities', () => {
  const { decisionIdentity, sameDecision } = require('../client.cjs');
  const original = { id: 'r', revision: 1, fingerprint: 'hash', gate: 1 };
  const oldDecision = decisionIdentity(original), resumed = { ...original, gate: 2 };
  assert.equal(sameReview(resumed, identity(original)), true);
  assert.equal(sameDecision(resumed, oldDecision), false);
  assert.equal(sameDecision(resumed, identity(original)), false);
  assert.equal(sameDecision(resumed, decisionIdentity(resumed)), true);
  assert.equal(sameDecision(original, identity(original)), true);
});
