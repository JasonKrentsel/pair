import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pairExtension from "../extensions/pair/index.ts";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { PAIR_CONTRACT } from "../extensions/pair/context.ts";
import { STATE_ENTRY } from "../extensions/pair/state.ts";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pair-simplified-")));
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
  const ctx: any = { cwd: root, hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {}, notify() {}, confirm: async () => true },
  };
  pairExtension(pi);
  const emit = async (name: string, event: any = {}) => {
    const results: any[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  const before = async () => (await emit("before_agent_start", { prompt: "Continue", messageType: "user", systemPrompt: "Stable host instructions" })).find(result => result?.systemPrompt);
  const metadata = () => JSON.stringify([...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })));
  await command.handler("on", ctx);
  return { root, entries, sent, tools, ctx, emit, before, metadata,
    async close() { await emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); } };
}

test("removed checkpoint and inline feedback controls are absent from schemas and stable prompt", async () => {
  const f = await fixture();
  try {
    const work = f.tools.get("pair_work"), step = f.tools.get("pair_step");
    assert.deepEqual(work.parameters.properties.action.anyOf.map((part: any) => part.const), ["status", "revise", "design", "approve_design"]);
    assert.deepEqual(Object.keys(step.parameters.properties), ["title", "why", "changes"]);
    for (const action of ["checkpoint", "feedback"]) assert.throws(() => work.prepareArguments({ action }), /Nothing ran/);
    for (const name of ["resume", "revises"]) assert.throws(() => step.prepareArguments({ [name]: "legacy-review" }), /Nothing ran/);
    assert.doesNotMatch(PAIR_CONTRACT, /checkpoint|inline question|pair_work feedback|pair_step resume|pinned/i);
  } finally { await f.close(); }
});

test("legacy memory and Q&A journals restore safely without context replay or authorization", async () => {
  const f = await fixture();
  try {
    const first = await f.before(), metadata = f.metadata();
    const state = structuredClone(f.entries.findLast(entry => entry.customType === STATE_ENTRY).data);
    state.memory = { checkpoint: { implemented: "OBSOLETE_MEMORY" }, constraints: [{ text: "OBSOLETE_PIN" }] };
    f.entries.push({ type: "custom", customType: STATE_ENTRY, data: state });
    f.entries.push({ type: "custom", customType: "pair-review-event-v1", data: { kind: "feedback", root: f.root, text: "OBSOLETE_QUESTION" } });
    f.entries.push({ type: "custom", customType: "pair-proposal-v1", data: { content: "OLD_SNAPSHOT" } });
    const entryCount = f.entries.length;
    for (const transition of ["session_start", "session_tree", "session_compact"]) {
      await f.emit(transition);
      const current = await f.before();
      assert.equal(current.systemPrompt, first.systemPrompt);
      assert.doesNotMatch(current.message?.content ?? "", /OBSOLETE_|OLD_SNAPSHOT/);
      assert.equal((await f.before()).message, undefined, "unchanged state must not repeat instructions");
      assert.equal(f.metadata(), metadata);
    }
    assert.equal(f.entries.length, entryCount, "restoring old data does not append new model or UI events");
    assert.deepEqual(f.sent, []);
    const result = await f.tools.get("pair_work").execute("status", { action: "status" }, undefined, undefined, f.ctx);
    assert.doesNotMatch(JSON.stringify(result), /OBSOLETE_|OLD_SNAPSHOT/);
    assert.ok((await f.emit("tool_call", { toolName: "write", input: { path: "blocked.ts", content: "x" } })).some(result => result?.block));
  } finally { await f.close(); }
});

test("removed bridge endpoints cannot modify a pending review or grant permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-removed-endpoints-"));
  const registryDir = join(root, "registry"), bridge = new PairReviewBridge({ registryDir });
  try {
    await bridge.start(root);
    const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
    const headers = { authorization: "Bearer " + registry.token, "content-type": "application/json" };
    const url = "http://127.0.0.1:" + registry.port;
    let decisions = 0;
    const review = bridge.publish({ title: "Keep approval", why: "Preserve the exact permission gate.", changes: [] }, () => decisions++);
    const first = await fetch(url + "/review", { headers });
    const wire = await first.json() as any;
    assert.equal("memory" in wire, false); assert.equal("feedback" in wire, false);
    for (const endpoint of ["/memory", "/feedback", "/feedback-state"]) {
      assert.equal((await fetch(url + endpoint, { method: "POST", headers, body: JSON.stringify({ action: "approve", reviewId: review.id }) })).status, 404);
    }
    assert.deepEqual(bridge.current, review); assert.equal(decisions, 0);
    assert.equal((await fetch(url + "/review", { headers: { ...headers, "if-none-match": first.headers.get("etag")! } })).status, 304);
  } finally { await bridge.close(); rmSync(root, { recursive: true, force: true }); }
});

test("historical pending questions and proposals reopen only as read-only results", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-legacy-question-"));
  const bridge = new PairReviewBridge({ registryDir: join(root, "registry") });
  try {
    await bridge.start(root);
    for (const status of ["Answering questions", "Ready to approve", "Awaiting permission"]) {
      const result = bridge.record({ reviewId: "old-review", title: "Old review", why: "Saved result", changes: [], status });
      assert.equal(result.pending, false); assert.equal(result.status, "Recorded result");
      assert.equal(bridge.decide({ action: "approve" }), false);
    }
  } finally { await bridge.close(); rmSync(root, { recursive: true, force: true }); }
});
