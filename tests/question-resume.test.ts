import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-question-resume-"));
  const registryDir = join(root, "registry"), bridge = new PairReviewBridge({ registryDir });
  const entries: any[] = [], executions: any[] = [], terminals: ((value: any) => void)[] = [];
  const handlers = new Map<string, Function[]>();
  let tool: any, batch = 0;
  const controller = registerStepPermissions({
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    registerTool(value: any) { tool = value; },
  } as any, {
    active: () => ({ root }), changed() {}, bridge,
    // Hold old terminals deliberately: late disposal must not decide a resumed gate.
    review: async () => new Promise(resolve => terminals.push(resolve)),
  });
  const ctx: any = {
    cwd: root, hasUI: true, mode: "tui", tools: [{ name: "write" }, { name: "bash" }],
    sessionManager: { getBranch: () => entries }, ui: { notify() {} },
    executeTool: async (name: string, input: any) => {
      assert.equal(controller.guard({ toolName: name, input, parentToolCallId: "request" } as any), undefined);
      executions.push({ name, input });
      const result = name === "write" ? await createWriteTool(root).execute("native", input) : { content: [{ type: "text", text: "command complete" }] };
      return { result, isError: false };
    },
  };
  const request = async (path: string, body: unknown) => {
    const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
    return fetch(`http://127.0.0.1:${registry.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${registry.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  };
  const run = async (args: any) => {
    const result = await tool.execute("request", tool.prepareArguments(args), undefined, undefined, ctx);
    entries.push({ type: "message", message: { role: "toolResult", toolName: "pair_step", content: result.content, details: result.details } });
    return result;
  };
  const waitPending = async (minimumTerminals: number) => {
    for (let i = 0; i < 300 && (!bridge.current?.pending || terminals.length < minimumTerminals); i++) await setImmediate();
    assert.ok(bridge.current?.pending, "a live permission gate must be opened");
    assert.equal(terminals.length, minimumTerminals);
    return bridge.current!;
  };
  const send = async (intents: ("ask" | "revise")[] = ["ask"]) => {
    const review = bridge.current!;
    const batchId = `batch-${++batch}`;
    const comments = intents.map((intent, index) => ({ id: `${batchId}-${index}`, changeIndex: 0,
      side: review.changes[0].command !== undefined ? "command" : "proposed", startLine: 1, endLine: 1, intent, text: intent === "ask" ? "Why this behavior?" : "Use the original behavior." }));
    const payload = { reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, batchId, comments };
    const response = await request("/feedback", payload);
    assert.equal(response.status, 200, await response.text());
    return payload;
  };
  const answer = (ids: string[]) => controller.replyFeedback(ctx, ids.map(threadId => ({ threadId, text: "This keeps the callers consistent." })));
  const identity = () => { const r = bridge.current!; return { reviewId: r.id, revision: r.revision, fingerprint: r.fingerprint }; };
  const args = { title: "Share the answer", why: "Keep one implementation.", changes: [{ tool: "write", path: "answer.ts", content: "export const answer = 42;\n// PRIVATE_COMPLETE_SNAPSHOT\n" }] };
  return { root, bridge, controller, ctx, tool, entries, executions, terminals, args, request, run, waitPending, send, answer, identity,
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
    async close() { await bridge.close(); for (const terminal of terminals) terminal({ action: "deny" }); rmSync(root, { recursive: true, force: true }); },
  };
}

test("question-only feedback resumes the same exact step after all answers and executes only after approval", async () => {
  const f = await fixture();
  try {
    const schema = JSON.stringify(f.tool.parameters);
    const first = f.run(f.args); const original = await f.waitPending(1);
    const originalIdentity = f.identity(), payload = await f.send(["ask", "ask"]);
    const paused = await first;
    assert.equal(paused.details.status, "Answering questions");
    assert.deepEqual(f.identity(), originalIdentity);
    assert.equal(f.executions.length, 0);
    assert.ok(!JSON.stringify(paused.content).includes("PRIVATE_COMPLETE_SNAPSHOT"));
    await assert.rejects(f.run({ resume: original.id }), /Answer every question/);
    assert.equal(f.answer([payload.comments[0].id]).resume, undefined);
    await assert.rejects(f.run({ resume: original.id }), /Answer every question/);
    assert.equal(f.answer([payload.comments[1].id]).resume, original.id);
    assert.equal(f.bridge.current?.pending, false, "answers are only metadata");
    assert.deepEqual(f.tool.reachesTools({ resume: original.id }), ["write"]);
    await assert.rejects(f.run({ ...f.args, resume: original.id }), /Supply only resume/);
    const resumed = f.run({ resume: original.id }); await f.waitPending(2);
    assert.deepEqual(f.identity(), originalIdentity);
    assert.deepEqual(f.bridge.current?.changes, original.changes);
    assert.equal(f.bridge.current?.status, "Ready to approve");
    assert.equal(f.executions.length, 0);
    // The retired terminal shares the review ID, but not ownership of this gate.
    f.terminals[0]({ action: "approve" }); await setImmediate();
    assert.equal(f.bridge.current?.pending, true);
    const retry = await f.request("/feedback", payload);
    assert.equal((await retry.json() as any).duplicate, true);
    assert.equal(f.bridge.current?.pending, true);
    assert.equal((await f.request("/decision", { ...originalIdentity, gate: original.gate, action: "approve" })).status, 409, "a delayed initial-gate approval cannot approve after answers");
    assert.equal((await f.request("/decision", { ...originalIdentity, action: "approve" })).status, 409, "legacy decisions cannot approve a resumed gate without its epoch");
    const approval = await f.request("/decision", { ...originalIdentity, gate: f.bridge.current!.gate, action: "approve" });
    assert.equal(approval.status, 200, await approval.text());
    assert.equal((await resumed).details.status, "Applied");
    assert.equal(f.executions.length, 1);
    await assert.rejects(f.run({ resume: original.id }), /no longer resumable/);
    assert.equal(JSON.stringify(f.tool.parameters), schema);
  } finally { await f.close(); }
});

test("another question on a resumed command requires its own answer and terminal approval still works", async () => {
  const f = await fixture();
  try {
    const first = f.run({ title: "Check behavior", why: "Check the boundary.", changes: [{ tool: "bash", command: "npm test" }] });
    const original = await f.waitPending(1); const identity = f.identity();
    const q1 = await f.send(); await first; f.answer([q1.comments[0].id]);
    const second = f.run({ resume: original.id }); await f.waitPending(2);
    const q2 = await f.send(); await second;
    await assert.rejects(f.run({ resume: original.id }), /Answer every question/);
    f.answer([q2.comments[0].id]);
    const third = f.run({ resume: original.id }); await f.waitPending(3);
    assert.deepEqual(f.identity(), identity);
    f.terminals[1]({ action: "deny" }); await setImmediate();
    assert.equal(f.bridge.current?.pending, true);
    f.terminals[2]({ action: "approve" });
    assert.equal((await third).details.status, "Applied");
    assert.equal(f.executions.length, 1);
    assert.equal(f.bridge.feedback.threads.length, 2);
  } finally { await f.close(); }
});

test("mixed questions and revision requests never resume the original proposal unchanged", async () => {
  const f = await fixture();
  try {
    const running = f.run(f.args); const original = await f.waitPending(1);
    const payload = await f.send(["ask", "revise"]); const result = await running;
    assert.equal(result.details.status, "Revision requested");
    assert.equal(f.answer([payload.comments[0].id]).resume, undefined);
    await assert.rejects(f.run({ resume: original.id }), /no longer resumable/);
    assert.equal(f.executions.length, 0);
  } finally { await f.close(); }
});

test("changed file baselines revoke a question pause without overwriting the human edit", async () => {
  const f = await fixture();
  try {
    const running = f.run(f.args); const original = await f.waitPending(1);
    const payload = await f.send(); await running; f.answer([payload.comments[0].id]);
    writeFileSync(join(f.root, "answer.ts"), "human edit");
    await assert.rejects(f.run({ resume: original.id }), /changed since this proposal/);
    assert.equal(f.bridge.questionPending, false);
    await assert.rejects(f.run({ resume: original.id }), /no longer resumable/);
    assert.equal(readFileSync(join(f.root, "answer.ts"), "utf8"), "human edit");
    assert.equal(f.executions.length, 0);
  } finally { await f.close(); }
});

test("cancellation, constraints, compaction and session changes invalidate question resumption", async () => {
  for (const answered of [false, true]) for (const event of ["cancel", "constraints", "session_compact", "session_tree", "session_start", "before_agent_start"]) {
    const f = await fixture();
    try {
      const running = f.run(f.args); const original = await f.waitPending(1);
      const payload = await f.send(); await running;
      if (answered) f.answer([payload.comments[0].id]);
      if (event === "cancel") f.bridge.cancel();
      else if (event === "constraints") f.controller.constraintsChanged();
      else await f.emit(event);
      await assert.rejects(f.run({ resume: original.id }), /no longer resumable/, event);
      assert.equal(f.executions.length, 0);
    } finally { await f.close(); }
  }
});

test("a denial of the resumed gate cannot be replayed as another approval request", async () => {
  const f = await fixture();
  try {
    const running = f.run(f.args); const original = await f.waitPending(1);
    const payload = await f.send(); await running; f.answer([payload.comments[0].id]);
    const resumed = f.run({ resume: original.id }); await f.waitPending(2);
    f.terminals[1]({ action: "deny" });
    assert.equal((await resumed).details.status, "Denied");
    await assert.rejects(f.run({ resume: original.id }), /no longer resumable/);
    assert.equal(f.executions.length, 0);
  } finally { await f.close(); }
});
