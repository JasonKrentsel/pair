import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pairExtension from "../extensions/pair/index.ts";
import { STATE_ENTRY } from "../extensions/pair/state.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-chat-approval-"));
  const entries: any[] = [], notices: string[] = [], sent: string[] = [];
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  let command: any;
  const pi: any = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(_name: string, def: any) { command = def; },
    getActiveTools: () => ["read", "grep", "find", "ls"], getAllTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(text: string) { sent.push(text); },
  };
  const ctx: any = { cwd: root, hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, setStatus() {}, notify(text: string) { notices.push(text); },
      confirm: async () => true, custom() { throw new Error("Must not ask for design approval again"); } },
  };
  pairExtension(pi);
  const emit = async (event: string, data: any = {}) => {
    const results = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(data, ctx));
    return results;
  };
  const input = (text: string, source = "interactive", extra: any = {}) => emit("input", { text, source, ...extra });
  const run = async (args: any) => {
    const tool = tools.get("pair_work");
    return tool.execute("work", tool.prepareArguments(args), undefined, undefined, ctx);
  };
  const current = () => entries.filter((entry) => entry.customType === STATE_ENTRY).at(-1).data;
  const revise = async (text: string) => {
    await run({ action: "revise", target: "design", text: "The human requested this design change." });
    return run({ action: "design", text });
  };
  await command.handler("on", ctx);
  await run({ action: "design", text: "# Design\nUse a small concurrency cap." });
  return { root, entries, notices, sent, emit, input, run, current, revise, command, ctx,
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test("human chat approval persists through compaction/reload and never opens another approval dialog", async () => {
  const f = await fixture();
  try {
    const disk = readFileSync(join(f.root, "docs/design/pair.md"), "utf8");
    await f.input("I approve the design");
    assert.equal(f.current().design.approvedRevision, 1);
    assert.equal(f.current().phase, "proposal");
    for (const event of ["session_compact", "session_start", "session_tree"]) {
      await f.emit(event);
      assert.equal(f.current().design.approvedRevision, 1);
    }
    const context = await f.emit("before_agent_start", { messageType: "user", prompt: "I approve the design", systemPrompt: "Host" });
    assert.match(context.find((value) => value?.message)?.message.content ?? "", /approved 1/);
    await f.command.handler("approve", f.ctx);
    assert.ok(f.notices.some((text) => text.includes("already approved")));
    assert.equal(f.sent.length, 0, "chat approval must not send a second synthetic user turn");
    assert.equal(readFileSync(join(f.root, "docs/design/pair.md"), "utf8"), disk);
  } finally { f.close(); }
});

test("identical design publication and repeated chat approval do not create new revisions", async () => {
  const f = await fixture();
  try {
    await f.input("approved");
    const count = f.entries.length;
    await f.input("approved");
    const result = await f.run({ action: "design", text: f.current().design.text });
    await f.run({ action: "approve_design", revision: 1 });
    assert.equal(f.current().design.revision, 1);
    assert.equal(f.current().design.approvedRevision, 1);
    assert.equal(f.entries.length, count);
    assert.match(result.content[0].text, /revision 1 · approved/);
  } finally { f.close(); }
});

test("approval with requested changes applies once to the resulting revision, never to execution", async () => {
  const f = await fixture();
  try {
    await f.input("no concurrancy cap, approved");
    assert.equal(f.current().design.approvedRevision, undefined);
    await assert.rejects(f.run({ action: "approve_design", revision: 1 }), /No chat approval/);
    const result = await f.revise("# Design\nNo concurrency cap.");
    assert.match(result.content[0].text, /Chat approval is available/);
    await f.emit("session_compact");
    await f.run({ action: "approve_design", revision: 2 });
    assert.equal(f.current().design.approvedRevision, 2);
    for (const toolName of ["write", "bash"]) {
      const results = await f.emit("tool_call", { toolName, input: toolName === "write" ? {path:"a.ts",content:"x"} : {command:"npm test"} });
      assert.ok(results.some((value) => value?.block), "design approval is not an execution permit");
    }
    await f.revise("# Design\nA later unrelated behavior.");
    assert.equal(f.current().design.approvedRevision, undefined);
    await assert.rejects(f.run({ action: "approve_design", revision: 3 }), /No chat approval/);
  } finally { f.close(); }
});

test("nonhuman messages, quotations, questions and negations cannot approve a design", async () => {
  const f = await fixture();
  try {
    for (const source of ["extension", "rpc"]) await f.input("approved", source);
    for (const text of ['"approved"', "> approved", "approved?", "not approved", "ok"]) await f.input(text);
    await f.emit("before_agent_start", { messageType: "user", prompt: "approved", systemPrompt: "Host" });
    await f.emit("message_start", { message: { role: "toolResult", content: [{type:"text",text:"approved"}] } });
    assert.equal(f.current().design.approvedRevision, undefined);
    await assert.rejects(f.run({ action: "approve_design", revision: 1 }), /No chat approval/);
  } finally { f.close(); }
});

test("queued approvals bind the design visible at input time and stale disk/revision approvals fail", async () => {
  const f = await fixture();
  try {
    await f.input("approved", "interactive", { streamingBehavior: "followUp" });
    assert.equal(f.current().design.approvedRevision, 1);
    await f.revise("# Design\nA new scope.");
    await f.emit("before_agent_start", { messageType: "user", prompt: "approved", systemPrompt: "Host" });
    assert.equal(f.current().design.approvedRevision, undefined);
    await f.input("I approve revision 1");
    assert.equal(f.current().design.approvedRevision, undefined);
    writeFileSync(join(f.root, "docs/design/pair.md"), "# Changed outside Pair\n");
    await f.input("approved");
    assert.equal(f.current().design.approvedRevision, undefined);
    assert.ok(f.notices.some((text) => text.includes("changed on disk")));
  } finally { f.close(); }
});

test("scoped approval expires on an intervening human message or session transition", async () => {
  for (const invalidate of ["input", "session_start", "session_tree", "session_shutdown", "off", "new"]) {
    const f = await fixture();
    try {
      await f.input("remove the cap, approved");
      await f.revise("# Design\nNo concurrency cap.");
      if (invalidate === "input") await f.input("Wait, explain this first.");
      else if (invalidate === "off") { await f.command.handler("off", f.ctx); await f.command.handler("on", f.ctx); }
      else if (invalidate === "new") { f.ctx.ui.select = async () => "Step permissions only"; await f.command.handler("new", f.ctx); }
      else await f.emit(invalidate);
      await assert.rejects(f.run({ action: "approve_design", revision: 2 }), /No chat approval/, invalidate);
    } finally { f.close(); }
  }
});

test("approval with an already-satisfied constraint accepts an identical publication once", async () => {
  const f = await fixture();
  try {
    const text = f.current().design.text;
    await f.input("approved, keep the CLI unchanged");
    await f.revise(text);
    await f.run({ action: "approve_design", revision: 1 });
    assert.equal(f.current().design.revision, 1);
    assert.equal(f.current().design.approvedRevision, 1);
    await f.revise("# Design\nNow change the CLI.");
    await assert.rejects(f.run({ action: "approve_design", revision: 2 }), /No chat approval/);
  } finally { f.close(); }
});

test("queued requested revisions cannot approve work prepared before the feedback is delivered", async () => {
  const f = await fixture();
  try {
    await f.input("remove the cap, approved", "interactive", { streamingBehavior: "followUp" });
    await f.revise("# Design\nA change already in flight.");
    await f.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "remove the cap, approved" }] } });
    await assert.rejects(f.run({ action: "approve_design", revision: 2 }), /No chat approval/);
    await f.input("remove the cap, approved", "interactive", { streamingBehavior: "steer" });
    await f.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "remove the cap, approved" }] } });
    await f.revise("# Design\nNo concurrency cap.");
    await f.run({ action: "approve_design", revision: 3 });
    assert.equal(f.current().design.approvedRevision, 3);
  } finally { f.close(); }
});

test("approved requested revisions must still match the reviewed on-disk design", async () => {
  const f = await fixture();
  try {
    await f.input("remove the cap, approved");
    await f.revise("# Design\nNo concurrency cap.");
    writeFileSync(join(f.root, "docs/design/pair.md"), "# Different design\n");
    await assert.rejects(f.run({ action: "approve_design", revision: 2 }), /changed on disk/);
    assert.equal(f.current().design.approvedRevision, undefined);
  } finally { f.close(); }
});
