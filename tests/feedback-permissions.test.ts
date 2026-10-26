import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";
import { prepareChanges } from "../extensions/pair/changes.ts";
import { reviseProposal, saveProposal, restoredProposal } from "../extensions/pair/proposals.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-feedback-permissions-"));
  const registryDir = join(root, "registry");
  const bridge = new PairReviewBridge({ registryDir });
  const handlers = new Map<string, Function[]>();
  const entries: any[] = [], executions: any[] = [];
  let tool: any, intent: "ask" | "revise" | "approve" = "revise", count = 0;
  const pi: any = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerTool(t: any) { tool = t; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
  };
  const controller = registerStepPermissions(pi, { active: () => ({ root }), changed() {}, bridge, review: async () => {
    if (intent === "approve") return { action: "approve" };
    const review = bridge.current!;
    const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
    const response = await fetch(`http://127.0.0.1:${registry.port}/feedback`, { method: "POST", headers: { authorization: `Bearer ${registry.token}`, "content-type": "application/json" }, body: JSON.stringify({
      reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, batchId: `batch-${++count}`,
      comments: [{ id: `thread-${count}`, changeIndex: 0, side: "proposed", startLine: 1, endLine: 1, intent, text: intent === "ask" ? "Why is this function needed?" : "Keep the public function name." }],
    }) });
    assert.equal(response.status, 200, await response.text());
    return { action: "deny" };
  } });
  const ctx: any = { cwd: root, hasUI: true, mode: "tui", tools: [{ name: "write" }, { name: "edit" }], sessionManager: { getBranch: () => entries }, ui: { notify() {} },
    executeTool: async (name: string, input: any) => {
      assert.equal(controller.guard({ toolName: name, input, parentToolCallId: "request" } as any), undefined);
      executions.push({ name, input });
      const result = await (name === "write" ? createWriteTool(root) : createEditTool(root)).execute("native", input);
      return { result, isError: Boolean(result.isError) };
    },
  };
  const run = async (changes?: any[], revises?: string) => {
    const result = await tool.execute("request", { title: "Share validation", why: "Keep caller behavior consistent.", changes, revises }, undefined, undefined, ctx);
    entries.push({ type: "message", message: { role: "toolResult", toolName: "pair_step", details: structuredClone(result.details), content: result.content } });
    return result;
  };
  return { root, bridge, controller, ctx, tool, entries, executions, run, setIntent(value: typeof intent) { intent = value; },
    emit(name: string) { for (const fn of handlers.get(name) ?? []) fn({}, ctx); },
    async close() { await bridge.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("section revision retains the other exact draft and applies only after a new approval", async () => {
  const f = await fixture();
  try {
    const first = await f.run([{ tool: "write", path: "a.ts", content: "export const answer = 1;\n" }, { tool: "write", path: "b.ts", content: "unchanged-proposed-file\n" }]);
    assert.equal(first.details.status, "Revision requested");
    assert.equal(f.executions.length, 0);
    assert.equal(f.bridge.current?.pending, false);
    assert.ok(!JSON.stringify(first.content).includes("unchanged-proposed-file"));
    const retainedId = first.details.reviewId;
    assert.deepEqual(f.tool.reachesTools({ revises: retainedId }), ["write"]);
    f.setIntent("approve");
    const result = await f.run([{ tool: "write", path: "a.ts", content: "export const publicAnswer = 1;\n", why: "Preserve `publicAnswer`.", annotations: [{ title: "Public contract", why: "Callers import this name.", startLine: 1, endLine: 1 }] }], retainedId);
    assert.equal(result.details.status, "Applied");
    assert.notEqual(result.details.reviewId, retainedId);
    assert.equal(result.details.revises, retainedId);
    assert.equal(readFileSync(join(f.root, "b.ts"), "utf8"), "unchanged-proposed-file\n");
    assert.equal(f.executions.length, 2);
    assert.equal("why" in f.executions[0].input, false);
    assert.equal("annotations" in f.executions[0].input, false);
    assert.equal(result.details.changes[0].why, "Preserve `publicAnswer`.");
  } finally { await f.close(); }
});

test("section questions pause mutations while allowing stored answers and no automatic approval", async () => {
  const f = await fixture();
  try {
    f.setIntent("ask");
    const result = await f.run([{ tool: "write", path: "a.ts", content: "export const answer = 1;\n" }]);
    assert.equal(result.details.status, "Answering questions");
    assert.ok(f.controller.guard({ toolName: "pair_step", input: {} } as any)?.block);
    assert.equal(f.controller.guard({ toolName: "pair_work", input: { action: "feedback" } } as any), undefined);
    f.controller.replyFeedback(f.ctx, [{ threadId: "thread-1", text: "The callers need one shared value." }]);
    assert.equal(f.bridge.feedback.threads[0].status, "answered");
    f.emit("session_compact");
    assert.ok(f.controller.guard({ toolName: "pair_step", input: {} } as any)?.block);
    assert.equal(f.executions.length, 0);
    assert.ok(f.controller.recoveryBrief().includes("thread-1"));
    assert.equal(f.controller.recoveryBrief(), "");
  } finally { await f.close(); }
});

test("reload retains proposals and feedback but does not restore an execution permit", async () => {
  const f = await fixture();
  try {
    const first = await f.run([{ tool: "write", path: "a.ts", content: "old proposal" }, { tool: "write", path: "b.ts", content: "retained" }]);
    f.emit("session_start");
    assert.ok(f.controller.guard({ toolName: "write", input: { path: "a.ts", content: "old proposal" }, parentToolCallId: "request" } as any)?.block);
    assert.equal(f.bridge.feedback.threads.length, 1);
    f.emit("before_agent_start");
    f.setIntent("approve");
    const revised = await f.run([{ tool: "write", path: "a.ts", content: "new proposal" }], first.details.reviewId);
    assert.equal(revised.details.status, "Applied");
    assert.equal(readFileSync(join(f.root, "b.ts"), "utf8"), "retained");
  } finally { await f.close(); }
});

test("every retained file baseline is checked, including files absent from the revision payload", async () => {
  const f = await fixture();
  try {
    const first = await f.run([{ tool: "write", path: "a.ts", content: "one" }, { tool: "write", path: "b.ts", content: "two" }]);
    writeFileSync(join(f.root, "b.ts"), "human change");
    f.setIntent("approve");
    await assert.rejects(f.run([{ tool: "write", path: "a.ts", content: "three" }], first.details.reviewId), /changed since this proposal/);
    assert.equal(f.executions.length, 0);
  } finally { await f.close(); }
});

test("explanation ranges are checked against the proposed source before a review", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-explanation-"));
  try {
    await assert.rejects(prepareChanges(root, [{ tool: "write", path: "a.ts", content: "one", annotations: [{ title: "Section", why: "Reason", startLine: 1, endLine: 2 }] }]), /existing proposed lines 1–1/);
    const original = [{ tool: "write" as const, path: "a.ts", content: "one" }];
    const prepared = await prepareChanges(root, original);
    const saved = saveProposal("proposal-123", root, "Title", "Why", original, prepared);
    assert.deepEqual(restoredProposal(saved, root), saved);
    assert.equal(restoredProposal({ ...saved, before: {} }, root), undefined);
    assert.deepEqual(reviseProposal(root, saved), original);
    assert.equal(restoredProposal({ ...saved, root: "elsewhere" }, root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
