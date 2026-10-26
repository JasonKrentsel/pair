import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pairExtension from "../extensions/pair/index.ts";
import { FeedbackStore, parseFeedbackBatch } from "../extensions/pair/feedback.ts";
import { REVIEW_EVENT_ENTRY } from "../extensions/pair/permissions.ts";
import type { BridgeReview } from "../extensions/pair/bridge.ts";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pair-cache-feedback-")));
  const entries: any[] = [], sent: string[] = [];
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  let command: any;
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(_name: string, definition: any) { command = definition; },
    getActiveTools: () => ["read", "grep", "find", "ls"], getAllTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendUserMessage(text: string) { sent.push(text); },
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {}, notify() {}, confirm: async () => true, select: async () => "Step permissions only" },
  };
  pairExtension(pi);
  const emit = async (name: string, event: any = {}) => {
    const results: any[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  const before = async () => {
    const results = await emit("before_agent_start", { prompt: "Continue", messageType: "user", systemPrompt: "Stable host instructions" });
    return results.find(result => result?.systemPrompt) as { systemPrompt: string; message?: { content: string } };
  };
  const metadata = () => JSON.stringify([...tools.values()].map(({ name, description, parameters, promptGuidelines, promptSnippet }) => ({ name, description, parameters, promptGuidelines, promptSnippet })));
  const store = new FeedbackStore();
  store.ensureRoot(root);
  store.setHandler(event => pi.appendEntry(REVIEW_EVENT_ENTRY, event));
  await command.handler("on", ctx);
  const review: BridgeReview = {
    id: "cache-review", revision: 1, fingerprint: "a".repeat(64), title: "Explain the prompt loader", why: "Keep the prompt separate from its loader.",
    status: "Awaiting permission", pending: true,
    changes: [{ label: "src/prompt.ts", kind: "Edit", added: 4001, removed: 1, before: "export const prompt = 'Inspect';\n", after: "export function loadPrompt() { return readPrompt(); }\n" + "// SNAPSHOT_ONLY_DO_NOT_SEND_TO_MODEL\n".repeat(4000) }],
  };
  const publishFeedback = () => {
    store.publish(review);
    store.submit(parseFeedbackBatch({ reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, batchId: "cache-batch", comments: [{ id: "cache-thread", changeIndex: 0, side: "proposed", startLine: 1, endLine: 1, intent: "ask", text: "Why does loading this file throw? " + "Please explain the failure path. ".repeat(20) }] }), review);
  };
  return { root, entries, sent, tools, ctx, emit, before, metadata, store, publishFeedback,
    async close() { await emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); } };
}

test("restored section feedback keeps the registered tool schema and system prefix stable", async () => {
  const f = await fixture();
  try {
    const metadata = f.metadata(), initial = await f.before();
    assert.ok(initial.systemPrompt.includes("Stable host instructions"));
    f.publishFeedback();
    const restoredStore = new FeedbackStore();
    restoredStore.restore(f.entries.filter(entry => entry.customType === REVIEW_EVENT_ENTRY).map(entry => entry.data), f.root);
    assert.equal(restoredStore.state.threads.length, 1, "the fixture journal must be independently restorable");
    const entryCount = f.entries.length;
    await f.emit("session_start");
    const recovered = await f.before();
    assert.equal(recovered.systemPrompt, initial.systemPrompt);
    assert.equal(f.metadata(), metadata);
    assert.match(recovered.message?.content ?? "", /cache-thread.*src\/prompt\.ts:1.*Why does loading this file throw/s);
    assert.ok((recovered.message?.content.length ?? 0) < 1000, "recovery should provide a bounded reference, not replay the proposal or full note");
    assert.ok(!recovered.message?.content.includes("SNAPSHOT_ONLY_DO_NOT_SEND_TO_MODEL"));
    assert.equal(f.entries.length, entryCount, "restoring review events must not append duplicates");
    for (let i = 0; i < 20; i++) {
      const next = await f.before();
      assert.equal(next.systemPrompt, initial.systemPrompt);
      assert.equal(next.message, undefined, "unchanged turns must not resend the recovery note or ordinary Pair state");
      assert.equal(f.metadata(), metadata);
    }
    await f.emit("session_compact");
    const compacted = await f.before();
    assert.equal(compacted.systemPrompt, initial.systemPrompt);
    assert.match(compacted.message?.content ?? "", /cache-thread/);
    assert.equal((await f.before()).message, undefined);
    assert.deepEqual(f.sent, [], "restore and recovery must not create synthetic human turns");
    assert.ok((await f.emit("tool_call", { toolName: "write", input: { path: "unauthorized.ts", content: "x" } })).some(result => result?.block), "restored feedback is never an execution permit");
  } finally { await f.close(); }
});

test("human thread resolution remains local and unresolved feedback can be recovered without schema churn", async () => {
  const f = await fixture();
  try {
    const metadata = f.metadata(), initial = await f.before();
    f.publishFeedback();
    await f.emit("session_tree");
    await f.before();
    f.store.setThreadState({ revision: f.store.state.revision, threadId: "cache-thread", status: "addressed" });
    await f.emit("session_tree");
    const addressed = await f.before();
    assert.equal(addressed.systemPrompt, initial.systemPrompt);
    assert.ok(!addressed.message?.content.includes("cache-thread"));
    f.store.setThreadState({ revision: f.store.state.revision, threadId: "cache-thread", status: "open" });
    await f.emit("session_tree");
    const reopened = await f.before();
    assert.match(reopened.message?.content ?? "", /cache-thread/);
    assert.equal(reopened.systemPrompt, initial.systemPrompt);
    assert.equal(f.metadata(), metadata);
    assert.deepEqual(f.sent, []);
    assert.ok(f.entries.filter(entry => entry.customType === REVIEW_EVENT_ENTRY).every(entry => entry.type === "custom" && !entry.message), "snapshot and comment events belong in the UI journal, not model messages");
    assert.equal((await f.before()).message, undefined);
  } finally { await f.close(); }
});
