import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { reviewWithCompanion } from "../extensions/pair/review-connection.ts";
import type { PermissionDecision } from "../extensions/pair/ui.ts";

const changes = [{ label: "src/agent.ts", kind: "Edit", before: "before", after: "after", added: 1, removed: 1 }];
const context: any = { ui: { notify() {} } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { resolve, reject, promise };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-review-connection-"));
  const bridge = new PairReviewBridge({ registryDir: join(root, "registry") });
  await bridge.start(root);
  const waitFor = async (title: string) => {
    for (let n = 0; n < 100 && bridge.current?.title !== title; n++) await setImmediate();
    assert.equal(bridge.current?.title, title);
    return bridge.current!;
  };
  const close = async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, bridge, waitFor, close };
}

test("a terminal result arriving after remote approval cannot decide the next review", async () => {
  const f = await fixture();
  try {
    const oldTerminal = deferred<PermissionDecision>();
    const first = reviewWithCompanion(f.bridge, f.root, context, "First", "Why", changes, undefined, {}, () => {}, () => oldTerminal.promise);
    await f.waitFor("First");
    f.bridge.decide({ action: "approve" });
    assert.deepEqual(await first, { action: "approve" });
    const nextTerminal = deferred<PermissionDecision>();
    const second = reviewWithCompanion(f.bridge, f.root, context, "Second", "Why", changes, undefined, {}, () => {}, () => nextTerminal.promise);
    const nextReview = await f.waitFor("Second");
    oldTerminal.resolve({ action: "deny", note: "This was for the old request" });
    await setImmediate();
    assert.equal(f.bridge.current?.id, nextReview.id);
    assert.equal(f.bridge.current?.pending, true);
    nextTerminal.resolve({ action: "approve" });
    assert.deepEqual(await second, { action: "approve" });
  } finally { await f.close(); }
});

test("a late terminal rejection cannot cancel a newer review", async () => {
  const f = await fixture();
  try {
    const oldTerminal = deferred<PermissionDecision>();
    const first = reviewWithCompanion(f.bridge, f.root, context, "First", "Why", changes, undefined, {}, () => {}, () => oldTerminal.promise);
    await f.waitFor("First");
    f.bridge.decide({ action: "approve" });
    await first;
    const next = f.bridge.publish({ title: "Second", why: "Why", changes }, () => {});
    oldTerminal.reject(new Error("Old terminal disposal failed"));
    await setImmediate();
    assert.equal(f.bridge.current?.id, next.id);
    assert.equal(f.bridge.current?.pending, true);
  } finally { await f.close(); }
});

test("replacing a review revokes its old terminal approval", async () => {
  const f = await fixture();
  try {
    const oldTerminal = deferred<PermissionDecision>();
    const first = reviewWithCompanion(f.bridge, f.root, context, "First", "Why", changes, undefined, {}, () => {}, () => oldTerminal.promise);
    await f.waitFor("First");
    let nextDecisions = 0;
    const next = f.bridge.publish({ title: "Second", why: "Why", changes }, () => nextDecisions++);
    oldTerminal.resolve({ action: "approve" });
    assert.deepEqual(await first, { action: "deny" });
    await setImmediate();
    assert.equal(f.bridge.current?.id, next.id);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal(nextDecisions, 0);
  } finally { await f.close(); }
});

test("cancellation while the bridge starts cannot publish a pending review", async () => {
  const f = await fixture();
  try {
    const starting = deferred<void>();
    f.bridge.start = () => starting.promise;
    const abort = new AbortController();
    let terminalCalls = 0;
    const running = reviewWithCompanion(f.bridge, f.root, context, "Cancelled", "Why", changes, abort.signal, {}, () => {}, async () => { terminalCalls++; return { action: "approve" }; });
    abort.abort();
    starting.resolve();
    assert.deepEqual(await running, { action: "deny" });
    assert.equal(f.bridge.current, undefined);
    assert.equal(terminalCalls, 0);
  } finally { await f.close(); }
});

test("a changed session during startup cannot replace another pending review", async () => {
  const f = await fixture();
  try {
    const starting = deferred<void>();
    f.bridge.start = () => starting.promise;
    const running = reviewWithCompanion(f.bridge, f.root, context, "Old session", "Why", changes, undefined, {}, () => { throw new Error("The Pi session changed"); }, async () => ({ action: "approve" }));
    const failure = assert.rejects(running, /session changed/);
    const next = f.bridge.publish({ title: "Current session", why: "Why", changes }, () => {});
    starting.resolve();
    await failure;
    assert.equal(f.bridge.current?.id, next.id);
    assert.equal(f.bridge.current?.pending, true);
  } finally { await f.close(); }
});

test("local stale approval seals only its review and returns for ordinary failure reporting", async () => {
  const f = await fixture();
  try {
    const terminal = deferred<PermissionDecision>();
    let stale = false;
    const running = reviewWithCompanion(f.bridge, f.root, context, "Stale", "Why", changes, undefined, {}, () => { if (stale) throw new Error("File changed"); }, () => terminal.promise);
    await f.waitFor("Stale");
    stale = true;
    terminal.resolve({ action: "approve" });
    assert.deepEqual(await running, { action: "approve" });
    assert.equal(f.bridge.current?.pending, false);
    assert.match(f.bridge.current!.status, /Stale/);
    assert.equal(f.bridge.decide({ action: "approve" }), false);
  } finally { await f.close(); }
});

test("abort resolves permission even when the terminal has not finished disposing", async () => {
  const f = await fixture();
  try {
    const terminal = deferred<PermissionDecision>();
    const abort = new AbortController();
    const running = reviewWithCompanion(f.bridge, f.root, context, "Pending", "Why", changes, abort.signal, {}, () => {}, () => terminal.promise);
    await f.waitFor("Pending");
    abort.abort();
    assert.deepEqual(await running, { action: "deny" });
    assert.equal(f.bridge.current?.pending, false);
    terminal.resolve({ action: "approve" });
    await setImmediate();
    assert.equal(f.bridge.current?.pending, false);
  } finally { await f.close(); }
});
