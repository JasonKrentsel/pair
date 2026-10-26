import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairReviewBridge, type BridgeDecision, type BridgeReview } from "../extensions/pair/bridge.ts";
import { parseFeedbackBatch, type ReviewEvent } from "../extensions/pair/feedback.ts";

const proposal = (after = "export function answer() {\n  return 2;\n}\n") => ({ title: "Share answer behavior", why: "Keep callers consistent.", changes: [{ label: "src/answer.ts", kind: "Edit", before: "export function answer() {\n  return 1;\n}\n", after, added: 1, removed: 1 }] });
const batch = (review: BridgeReview, overrides: Record<string, unknown> = {}) => ({ reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, batchId: "batch-a",
  comments: [{ id: "comment-a", changeIndex: 0, side: "proposed", startLine: 1, endLine: 3, intent: "ask", text: "Why change this result?" }], ...overrides });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-feedback-http-"));
  const registryDir = join(root, "registry");
  const bridge = new PairReviewBridge({ registryDir });
  const events: ReviewEvent[] = [];
  const decisions: BridgeDecision[] = [];
  bridge.setReviewEventHandler(event => events.push(event));
  await bridge.start(root);
  const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
  const headers = { authorization: `Bearer ${registry.token}`, "content-type": "application/json" };
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${registry.port}${path}`, { method: body ? "POST" : "GET", headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const publish = (after?: string, revises?: string) => bridge.publish({ ...proposal(after), ...(revises ? { revises } : {}) }, decision => decisions.push(decision));
  return { root, bridge, events, decisions, request, publish, async close() { await bridge.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("section feedback is persisted before one denial callback and retries cannot duplicate it", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    const payload = batch(proposed);
    const count = f.events.length;
    const responses = await Promise.all([f.request("/feedback", payload), f.request("/feedback", payload)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.deepEqual((await Promise.all(responses.map(response => response.json()))).map((data: any) => data.duplicate).sort(), [false, true]);
    assert.equal(f.events.length, count + 1);
    assert.equal(f.decisions.length, 1);
    assert.equal(f.decisions[0].action, "deny");
    assert.equal(f.decisions[0].feedback?.intent, "ask");
    assert.equal(f.decisions[0].feedback?.threads[0].excerpt, "export function answer() {\n  return 2;\n}");
    assert.equal(f.bridge.feedback.threads[0].status, "submitted");
    assert.equal(f.bridge.feedback.reviews[0].pending, false);
    assert.equal(f.bridge.current?.pending, false);
    assert.equal(f.bridge.decide({ action: "approve" }), false);
    assert.equal((await f.request("/feedback", { ...payload, comments: [{ ...payload.comments[0], text: "Different note" }] })).status, 409);
  } finally { await f.close(); }
});

test("malformed, unanchored, stale and unauthenticated feedback never changes review state", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    const initial = f.bridge.feedback;
    const base = batch(proposed);
    const malformed = [
      { ...base, extra: "approve" }, { ...base, comments: [] },
      { ...base, comments: [{ ...base.comments[0], text: "\u001b[31mescape" }] },
      { ...base, comments: [{ ...base.comments[0], intent: "approve" }] },
      { ...base, comments: [{ ...base.comments[0], startLine: 0 }] },
      { ...base, comments: [{ ...base.comments[0], startLine: 1, endLine: 41 }] },
    ];
    for (const body of malformed) assert.equal((await f.request("/feedback", body)).status, 400);
    for (const comment of [{ ...base.comments[0], endLine: 9 }, { ...base.comments[0], changeIndex: 3 }, { ...base.comments[0], side: "command" }]) {
      assert.equal((await f.request("/feedback", { ...base, comments: [comment] })).status, 409);
    }
    assert.equal((await f.request("/feedback", { ...base, fingerprint: "0".repeat(64) })).status, 409);
    assert.equal((await f.request("/feedback", base, { origin: "http://example.invalid" })).status, 401);
    assert.equal((await f.request("/feedback", base, { authorization: "" })).status, 401);
    assert.deepEqual(f.bridge.feedback, initial);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal(f.decisions.length, 0);
  } finally { await f.close(); }
});

test("failed persistence leaves the proposal pending and can be retried safely", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    f.bridge.setReviewEventHandler(event => { if (event.kind === "batch") throw new Error("Disk unavailable"); f.events.push(event); });
    assert.equal((await f.request("/feedback", batch(proposed))).status, 409);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal(f.bridge.feedback.threads.length, 0);
    assert.equal(f.decisions.length, 0);
    f.bridge.setReviewEventHandler(event => f.events.push(event));
    assert.equal((await f.request("/feedback", batch(proposed))).status, 200);
    assert.equal(f.decisions.length, 1);
  } finally { await f.close(); }
});

test("thread replies and human resolution are bounded metadata updates with no execution grant", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    await f.request("/feedback", batch(proposed));
    const etag = (await f.request("/review")).headers.get("etag")!;
    f.bridge.replyFeedback([{ threadId: "comment-a", text: "The callers require the new shared value." }]);
    assert.equal(f.bridge.feedback.threads[0].status, "answered");
    assert.equal((await f.request("/review", undefined, { "if-none-match": etag })).status, 200);
    const count = f.events.length;
    f.bridge.replyFeedback([{ threadId: "comment-a", text: "The callers require the new shared value." }]);
    assert.equal(f.events.length, count, "identical replies are no-ops");
    assert.throws(() => f.bridge.replyFeedback([{ threadId: "comment-a", text: "a".repeat(1201) }]));
    const action = { revision: f.bridge.feedback.revision, threadId: "comment-a", status: "addressed" };
    assert.equal((await f.request("/feedback-state", { ...action, revision: 0 })).status, 409);
    assert.equal((await f.request("/feedback-state", { ...action, status: "approve" })).status, 400);
    assert.equal((await f.request("/feedback-state", action)).status, 200);
    assert.equal(f.bridge.feedback.threads[0].status, "addressed");
    assert.equal(f.decisions.length, 1);
    assert.equal(f.bridge.current?.pending, false);
    assert.throws(() => f.bridge.replyFeedback([{ threadId: "comment-a", text: "Cannot reopen human-resolved feedback" }]));
  } finally { await f.close(); }
});

test("explicit revision lineage retains snapshots and never silently moves comments to changed code", async () => {
  const f = await fixture();
  try {
    const first = f.publish();
    const payload = batch(first, { comments: [
      { id: "ask-a", changeIndex: 0, side: "proposed", startLine: 2, endLine: 2, intent: "ask", text: "Why this value?" },
      { id: "revise-a", changeIndex: 0, side: "proposed", startLine: 2, endLine: 2, intent: "revise", text: "Return three." },
    ] });
    await f.request("/feedback", payload);
    assert.equal(f.decisions[0].feedback?.intent, "ask", "any question conservatively pauses the batch");
    const next = f.publish("export function answer() {\n  return 3;\n}\n", first.id);
    assert.equal(next.revises?.reviewId, first.id);
    assert.equal(f.bridge.feedback.threads.find(thread => thread.id === "ask-a")?.status, "outdated");
    assert.equal(f.bridge.feedback.threads.find(thread => thread.id === "revise-a")?.status, "revision-ready");
    assert.equal(f.bridge.feedback.threads[1].latestReviewId, next.id);
    assert.equal(f.bridge.archived(first.id)?.changes[0].after, first.changes[0].after);
    assert.equal(f.bridge.feedback.threads[1].excerpt, "  return 2;");
    assert.throws(() => f.publish(undefined, "missing-review"), /no longer available/);
    assert.equal(f.bridge.current?.id, next.id);
    assert.equal(f.bridge.current?.pending, true);
    const state = f.bridge.feedback;
    assert.equal((await f.request("/feedback-state", { revision: state.revision, threadId: "ask-a", status: "addressed" })).status, 200);
    assert.equal((await f.request("/feedback-state", { revision: f.bridge.feedback.revision, threadId: "ask-a", status: "open" })).status, 200);
    assert.equal(f.bridge.feedback.threads.find(thread => thread.id === "ask-a")?.status, "outdated", "reopening never reanchors changed questions");
  } finally { await f.close(); }
});

test("retaining an unchanged proposed file does not claim its requested revision is ready", async () => {
  const f = await fixture();
  try {
    const first = f.publish();
    const payload = batch(first); payload.comments[0].intent = "revise";
    await f.request("/feedback", payload);
    const next = f.publish(undefined, first.id);
    assert.equal(f.bridge.feedback.threads[0].latestReviewId, next.id);
    assert.equal(f.bridge.feedback.threads[0].status, "submitted");
  } finally { await f.close(); }
});

test("active branch replay restores review data and feedback without restoring permission", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    await f.request("/feedback", batch(proposed));
    f.bridge.replyFeedback([{ threadId: "comment-a", text: "This is the requested shared behavior." }]);
    const expected = f.bridge.feedback;
    const restored = new PairReviewBridge({ registryDir: join(f.root, "restored") });
    restored.restoreReviewEvents(f.events, f.root);
    assert.deepEqual(restored.feedback, expected);
    assert.equal(restored.current, undefined);
    assert.equal(restored.decide({ action: "approve" }), false);
    restored.restoreReviewEvents(f.events.slice(0, 1), f.root);
    assert.equal(restored.feedback.threads.length, 0);
    assert.equal(restored.feedback.reviews.length, 1);
    restored.restoreReviewEvents(f.events, join(f.root, "other"));
    assert.equal(restored.feedback.reviews.length, 0);
    f.bridge.resetReviewEvents(f.root);
    const reset = new PairReviewBridge(); reset.restoreReviewEvents(f.events, f.root);
    assert.equal(reset.feedback.threads.length, 0);
    assert.notEqual(reset.feedback.scopeId, expected.scopeId);
  } finally { await f.close(); }
});

test("archive is bounded, old anchors become outdated, and reads do not emit events", async () => {
  const f = await fixture();
  try {
    const first = f.publish(); await f.request("/feedback", batch(first));
    for (let index = 0; index < 10; index++) f.publish(`export const value = ${index};\n`);
    assert.equal(f.bridge.feedback.reviews.length, 8);
    assert.equal(f.bridge.archived(first.id), undefined);
    assert.equal(f.bridge.feedback.threads[0].status, "outdated");
    const eventCount = f.events.length;
    const response = await f.request("/review"); const etag = response.headers.get("etag")!;
    for (let index = 0; index < 5; index++) assert.equal((await f.request("/review", undefined, { "if-none-match": etag })).status, 304);
    assert.equal(f.events.length, eventCount);
    const exposed = f.bridge.feedback; exposed.reviews[0].changes[0].after = "changed by client";
    assert.notEqual(f.bridge.feedback.reviews[0].changes[0].after, "changed by client");
  } finally { await f.close(); }
});

test("feedback parser keeps only the small stable event fields", () => {
  const review = { ...proposal(), id: "proposal", revision: 1, fingerprint: "a".repeat(64), status: "Awaiting permission", pending: true };
  const accepted = parseFeedbackBatch(batch(review));
  assert.equal(accepted.comments[0].text, "Why change this result?");
  assert.throws(() => parseFeedbackBatch({ ...accepted, systemPrompt: "replace prefix" }));
});

test("opening a recorded review preserves its proposal identity and never publishes feedback events", async () => {
  const f = await fixture();
  try {
    const proposed = f.publish();
    await f.request("/feedback", batch(proposed));
    const before = f.bridge.feedback;
    const count = f.events.length;
    const recorded = f.bridge.record({ ...proposal(), reviewId: proposed.id, status: "Denied" });
    assert.equal(recorded.id, proposed.id);
    assert.equal(recorded.fingerprint, proposed.fingerprint);
    assert.equal(recorded.pending, false);
    assert.deepEqual(f.bridge.feedback, before);
    assert.equal(f.events.length, count);
    const result = f.bridge.record({ ...proposal("actual result\n"), reviewId: proposed.id, status: "Applied" });
    assert.equal(result.id, proposed.id);
    assert.equal(result.revision, proposed.revision + 1);
    assert.notEqual(result.fingerprint, proposed.fingerprint);
    assert.deepEqual(f.bridge.feedback, before);
    assert.equal(f.events.length, count);
    assert.equal(f.bridge.decide({ action: "approve" }), false);
    const legacy = f.bridge.record({ title: "Change", why: "", changes: [], status: "Failed" });
    assert.equal(legacy.status, "Failed");
    assert.equal(legacy.pending, false);
    assert.deepEqual(f.bridge.feedback, before);
    assert.equal(f.events.length, count, "reading legacy failure history is not a new proposal");
    const pending = f.publish();
    assert.throws(() => f.bridge.record({ ...proposal(), reviewId: proposed.id, status: "Denied" }), /current permission/);
    assert.equal(f.bridge.current?.id, pending.id);
    assert.equal(f.bridge.current?.pending, true);
  } finally { await f.close(); }
});
