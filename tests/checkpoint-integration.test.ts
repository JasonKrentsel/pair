import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import pairExtension from "../extensions/pair/index.ts";
import { normalizeMemory } from "../extensions/pair/checkpoint.ts";
import { STATE_ENTRY } from "../extensions/pair/state.ts";

const report = {
  objective: "Make worker recovery usable",
  implemented: "Recovery reader and serialized checkpoint writer",
  verification: "23 scripted unit tests passed; CLI integration is not tested",
  usable: "Test fixtures only; the application still cannot resume a run",
  deferred: "CLI integration remains deferred at the human's request",
  next: "Choose the resume command interface",
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-checkpoint-integration-"));
  const priorRegistry = process.env.PI_PAIR_BRIDGE_DIR;
  process.env.PI_PAIR_BRIDGE_DIR = join(root, "bridge");
  const entries: any[] = [], notices: string[] = [], sent: string[] = [], executed: string[] = [];
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  let command: any, idle = true, decision: any = { action: "deny" };
  const pi: any = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(_name: string, definition: any) { command = definition; },
    getActiveTools: () => ["read", "grep", "find", "ls", "write", "edit"],
    getAllTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(text: string) { sent.push(text); },
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: "tui", isIdle: () => idle,
    tools: [{ name: "write" }, { name: "edit" }, { name: "bash" }],
    sessionManager: { getBranch: () => entries },
    ui: {
      setWidget() {}, setStatus() {}, notify(text: string) { notices.push(text); },
      confirm: async () => true, select: async () => "Step permissions only",
      custom: async () => decision,
    },
    executeTool: async (name: string, input: any) => {
      const guarded = await emit("tool_call", { toolName: name, input, parentToolCallId: "step" });
      assert.ok(guarded.every(value => !value?.block), "the exact reviewed child action should have a permit");
      executed.push(name);
      if (name === "bash") return { isError: false, result: { content: [{ type: "text", text: "Scripted command completed." }] } };
      const native = name === "write" ? createWriteTool(root) : createEditTool(root);
      const result = await native.execute("native", input);
      return { isError: Boolean(result.isError), result };
    },
  };
  pairExtension(pi);
  const emit = async (event: string, data: any = {}) => {
    const results: any[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(data, ctx));
    return results;
  };
  const input = (text: string, source = "interactive", extra: any = {}) => emit("input", { text, source, ...extra });
  const delivered = (text: string) => emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
  const current = () => entries.filter(entry => entry.customType === STATE_ENTRY).at(-1).data;
  const memory = () => normalizeMemory(current().memory);
  const run = async (args: any) => {
    const tool = tools.get("pair_work");
    return tool.execute("work", tool.prepareArguments(args), undefined, undefined, ctx);
  };
  const step = async (path: string, content: string) => {
    const tool = tools.get("pair_step");
    const args = tool.prepareArguments({ title: "Record one implementation file", why: "Expose the approved behavior in the application", changes: [{ tool: "write", path, content }] });
    return tool.execute("step", args, new AbortController().signal, undefined, ctx);
  };
  const shellStep = async () => {
    const tool = tools.get("pair_step");
    const args = tool.prepareArguments({ title: "Run the focused recovery check", why: "Check the latest recovery behavior", changes: [{ tool: "bash", command: "npm test -- recovery" }] });
    return tool.execute("step", args, new AbortController().signal, undefined, ctx);
  };
  const guard = (toolName: string, args: any) => emit("tool_call", { toolName, input: args });
  const before = (prompt = "Continue") => emit("before_agent_start", { messageType: "user", prompt, systemPrompt: "Host prompt" });
  await command.handler("on", ctx);
  return {
    root, entries, notices, sent, executed, ctx, command, emit, input, delivered, current, memory, run, step, shellStep, guard, before,
    setIdle(value: boolean) { idle = value; },
    decide(value: any) { decision = value; },
    async close() {
      await emit("session_shutdown");
      if (priorRegistry === undefined) delete process.env.PI_PAIR_BRIDGE_DIR;
      else process.env.PI_PAIR_BRIDGE_DIR = priorRegistry;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("checkpoint publication persists all six facts without changing design approval or granting execution", async () => {
  const f = await fixture();
  try {
    await f.run({ action: "design", text: "# Design\nMake recovery explicit." });
    await f.input("I approve the design");
    await f.command.handler("constraint task No automatic installation", f.ctx);
    const previous = structuredClone(f.current());
    const result = await f.run({ action: "checkpoint", checkpoint: report });
    for (const [key, value] of Object.entries(report)) assert.equal(f.memory().checkpoint?.[key as keyof typeof report], value);
    assert.deepEqual(f.current().design, previous.design);
    assert.equal(f.current().phase, previous.phase);
    assert.deepEqual(f.memory().constraints, previous.memory.constraints);
    assert.match(result.content[0].text, /Checkpoint 1 saved/);
    assert.ok(result.content[0].text.length < 120, "tool receipt should not repeat the report");
    assert.ok(!result.content[0].text.includes(report.verification));
    const entryCount = f.entries.length;
    const saved = structuredClone(f.current());
    await f.run({ action: "checkpoint", checkpoint: report });
    assert.equal(f.entries.length, entryCount, "an identical checkpoint should not append another state snapshot");
    assert.deepEqual(f.current(), saved, "an identical checkpoint must preserve the saved review and design approval");
    for (const event of ["session_compact", "session_tree", "session_start"]) {
      await f.emit(event);
      assert.equal(f.memory().checkpoint?.usable, report.usable);
      assert.equal(f.current().design.approvedRevision, 1);
    }
    const blocked = await f.guard("write", { path: "unauthorized.ts", content: "x" });
    assert.ok(blocked.some(value => value?.block));
    assert.deepEqual(f.executed, []);
  } finally { await f.close(); }
});

test("agent checkpoint arguments cannot change human constraints or approval metadata", async () => {
  const f = await fixture();
  try {
    await f.command.handler("constraint task Keep the public API unchanged", f.ctx);
    const pinned = f.memory().constraints;
    for (const patch of [{ next: "Continue", constraints: [] }, { next: "Continue", approved: true }, { next: "Continue", stale: false }]) {
      await assert.rejects(f.run({ action: "checkpoint", checkpoint: patch }), /pair_work:.*Nothing ran/);
      assert.deepEqual(f.memory().constraints, pinned);
    }
    await f.run({ action: "checkpoint", checkpoint: { next: "Discuss the API" }, constraints: [] });
    assert.deepEqual(f.memory().constraints, pinned, "unrecognized top-level fields cannot mutate memory");
    assert.equal(f.memory().checkpoint?.next, "Discuss the API");
  } finally { await f.close(); }
});

test("human constraint commands retain exact text and scope without executing or sending a model turn", async () => {
  const f = await fixture();
  try {
    await f.command.handler("constraint task No new packages", f.ctx);
    await f.command.handler("constraint turn Explain before editing", f.ctx);
    assert.deepEqual(f.memory().constraints.map(({ text, scope, pendingTurn }) => ({ text, scope, pendingTurn })), [
      { text: "No new packages", scope: "task", pendingTurn: undefined },
      { text: "Explain before editing", scope: "turn", pendingTurn: true },
    ]);
    assert.deepEqual(f.executed, []);
    assert.deepEqual(f.sent, []);
    assert.ok((await f.guard("write", { path: "a.ts", content: "x" })).some(value => value?.block));
  } finally { await f.close(); }
});

test("idle turn constraints survive the next chat input, then expire at the following human turn", async () => {
  const f = await fixture();
  try {
    await f.command.handler("constraint task No installation", f.ctx);
    await f.command.handler("constraint turn Explain first", f.ctx);
    await f.input("Explain the implementation");
    assert.equal(f.memory().constraints.length, 2);
    assert.equal(f.memory().constraints[1].pendingTurn, undefined);
    await f.delivered("Explain the implementation");
    assert.equal(f.memory().constraints.length, 2, "immediate input cannot expire a second time at message_start");
    await f.emit("session_compact");
    assert.equal(f.memory().constraints.length, 2);
    await f.input("Now continue");
    assert.deepEqual(f.memory().constraints.map(item => item.text), ["No installation"]);
  } finally { await f.close(); }
});

test("an active-turn constraint expires on the next immediate human input", async () => {
  const f = await fixture();
  try {
    f.setIdle(false);
    await f.command.handler("constraint turn Skip additional tests", f.ctx);
    assert.equal(f.memory().constraints[0].pendingTurn, undefined);
    await f.input("Proceed with the next task");
    assert.deepEqual(f.memory().constraints, []);
  } finally { await f.close(); }
});

test("queued interactive input advances constraints only when its user message is delivered", async () => {
  const f = await fixture();
  try {
    f.setIdle(false);
    await f.command.handler("constraint turn Stop after the current edit", f.ctx);
    await f.input("Continue after this run", "interactive", { streamingBehavior: "followUp" });
    assert.equal(f.memory().constraints.length, 1);
    await f.emit("message_start", { message: { role: "assistant", content: [{ type: "text", text: "Continue after this run" }] } });
    await f.delivered("An extension-generated follow-up");
    assert.equal(f.memory().constraints.length, 1);
    await f.delivered("Continue after this run");
    assert.deepEqual(f.memory().constraints, []);
    f.setIdle(true);
    await f.command.handler("constraint turn Explain the next step", f.ctx);
    await f.input("Next queued task", "interactive", { streamingBehavior: "steer" });
    assert.equal(f.memory().constraints[0].pendingTurn, true);
    await f.delivered("Next queued task");
    assert.equal(f.memory().constraints[0].pendingTurn, undefined);
    assert.equal(f.memory().constraints.length, 1);
    await f.input("Another human task");
    assert.deepEqual(f.memory().constraints, []);
  } finally { await f.close(); }
});

test("extension and RPC input or unproven user messages never expire human turn constraints", async () => {
  const f = await fixture();
  try {
    f.setIdle(false);
    await f.command.handler("constraint turn No more checks in this run", f.ctx);
    for (const source of ["extension", "rpc"]) {
      await f.input("Continue", source, { streamingBehavior: "followUp" });
      await f.delivered("Continue");
      assert.equal(f.memory().constraints.length, 1);
    }
    await f.before("Continue");
    assert.equal(f.memory().constraints.length, 1);
  } finally { await f.close(); }
});

test("checkpoint reporting remains available after denial and during discussion without enabling mutations", async () => {
  const f = await fixture();
  try {
    f.decide({ action: "deny" });
    const denied = await f.step("not-applied.ts", "export const value = 1;\n");
    assert.equal(denied.details.status, "Denied");
    for (const action of ["checkpoint", "status"]) assert.ok((await f.guard("pair_work", { action })).every(value => !value?.block));
    assert.ok((await f.guard("pair_step", {})).some(value => value?.block));
    await f.run({ action: "checkpoint", checkpoint: { implemented: "No changes applied", verification: "No checks run", next: "Wait for human direction" } });
    await f.before("Discussion only; preserve the current approval state and make no edits: explain recovery");
    assert.ok((await f.guard("pair_work", { action: "checkpoint" })).every(value => !value?.block));
    assert.ok((await f.guard("pair_work", { action: "design" })).some(value => value?.block));
    assert.ok((await f.guard("pair_step", {})).some(value => value?.block));
    await f.run({ action: "checkpoint", checkpoint: { next: "Discuss the recovery boundary" } });
    assert.equal(f.memory().checkpoint?.next, "Discuss the recovery boundary");
    assert.deepEqual(f.executed, []);
  } finally { await f.close(); }
});

test("starting fresh step-only work clears old checkpoint and both constraint scopes", async () => {
  const f = await fixture();
  try {
    await f.run({ action: "checkpoint", checkpoint: report });
    await f.command.handler("constraint task No deployment", f.ctx);
    await f.command.handler("constraint turn Explain first", f.ctx);
    await f.command.handler("new", f.ctx);
    assert.equal(f.current().active, true);
    assert.deepEqual(f.memory(), { revision: 0, constraints: [] });
    assert.equal(f.current().design.path, "");
    assert.deepEqual(f.sent, []);
  } finally { await f.close(); }
});

test("legacy sessions without memory restore without inventing a checkpoint or approval", async () => {
  const f = await fixture();
  try {
    assert.equal(f.current().memory, undefined);
    for (const event of ["session_start", "session_compact", "session_tree"]) await f.emit(event);
    assert.deepEqual(f.memory(), { revision: 0, constraints: [] });
    assert.equal(f.current().design.approvedRevision, undefined);
    const result = await f.run({ action: "status" });
    assert.doesNotMatch(result.content[0].text, /implemented|verified|usable|approved/);
    await f.run({ action: "checkpoint", checkpoint: { next: "Review the existing application" } });
    assert.equal(f.memory().checkpoint?.verification, "");
  } finally { await f.close(); }
});

test("an approved file change marks verification stale until the agent explicitly refreshes verification", async () => {
  const f = await fixture();
  try {
    await f.run({ action: "checkpoint", checkpoint: report });
    f.decide({ action: "approve" });
    const result = await f.step("recovery.ts", "export const resumable = true;\n");
    assert.equal(result.details.status, "Applied");
    assert.equal(readFileSync(join(f.root, "recovery.ts"), "utf8"), "export const resumable = true;\n");
    assert.equal(f.memory().checkpoint?.stale, true);
    assert.equal(f.memory().checkpoint?.verification, report.verification);
    await f.run({ action: "checkpoint", checkpoint: { next: "Review the newly integrated recovery command" } });
    assert.equal(f.memory().checkpoint?.stale, true);
    await f.run({ action: "checkpoint", checkpoint: { verification: "Not rerun after the latest edit" } });
    assert.equal(f.memory().checkpoint?.stale, false);
    assert.deepEqual(f.executed, ["write"]);
  } finally { await f.close(); }
});

test("approved shell execution stales old verification while a denied shell proposal preserves it", async () => {
  const f = await fixture();
  try {
    await f.run({ action: "checkpoint", checkpoint: report });
    const saved = structuredClone(f.memory());
    f.decide({ action: "deny" });
    const denied = await f.shellStep();
    assert.equal(denied.details.status, "Denied");
    assert.deepEqual(f.memory(), saved, "a proposal that never executed cannot stale verification");
    assert.deepEqual(f.executed, []);
    await f.input("Run the focused check now");
    await f.before("Run the focused check now");
    f.decide({ action: "approve" });
    const approved = await f.shellStep();
    assert.equal(approved.details.status, "Applied");
    assert.deepEqual(f.executed, ["bash"], "the shell stub ran only after approval");
    assert.equal(f.memory().checkpoint?.stale, true);
    assert.equal(f.memory().checkpoint?.verification, report.verification, "command output must not silently rewrite the agent's report");
    assert.ok(f.memory().revision > saved.revision);
  } finally { await f.close(); }
});

test("unchanged agent starts do not replay checkpoint context and the stable system prefix is preserved", async () => {
  const f = await fixture();
  try {
    await f.run({ action: "checkpoint", checkpoint: report });
    await f.command.handler("constraint task No automatic installation", f.ctx);
    const first = (await f.before()).find(value => value?.systemPrompt);
    assert.match(first.message.content, /No automatic installation/);
    assert.ok(first.message.content.includes(report.usable));
    const second = (await f.before()).find(value => value?.systemPrompt);
    assert.equal(second.message, undefined);
    assert.equal(second.systemPrompt, first.systemPrompt);
    await f.run({ action: "checkpoint", checkpoint: { next: report.next } });
    const identical = (await f.before()).find(value => value?.systemPrompt);
    assert.equal(identical.message, undefined);
    await f.run({ action: "checkpoint", checkpoint: { next: "Connect the CLI resume option" } });
    const updated = (await f.before()).find(value => value?.systemPrompt);
    assert.match(updated.message.content, /Connect the CLI resume option/);
    assert.equal(updated.systemPrompt, first.systemPrompt);
  } finally { await f.close(); }
});
