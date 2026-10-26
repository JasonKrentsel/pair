import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerStepPermissions, routineCommand } from "../extensions/pair/permissions.ts";
import pairExtension from "../extensions/pair/index.ts";

test("routine Git paths cannot contain evaluated PowerShell expressions", () => {
  // These strings are inspected only; no command is executed by this test.
  for (const command of [
    "git diff -- (New-Item injected)",
    "git diff -- @(New-Item injected)",
    "git diff -- { New-Item injected }",
  ]) assert.equal(routineCommand(command), false, command);
});

test("opening Pair during a pending permission focuses the existing review without execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-focus-test-"));
  let tool: any;
  let decide: (decision: { action: "deny" }) => void = () => {};
  let reviewCalls = 0, focusCalls = 0, executionCalls = 0;
  const pi: any = { on() {}, registerTool(definition: any) { tool = definition; }, appendEntry() {} };
  const controller = registerStepPermissions(pi, {
    active: () => ({ root }), changed() {},
    review: async (_ctx, _title, _why, _changes, _signal, options) => {
      reviewCalls++;
      options?.onHandle?.({ focus() { focusCalls++; }, setHidden() {} } as any);
      const decision = await new Promise<{ action: "deny" }>((resolve) => { decide = resolve; });
      options?.onClose?.();
      return decision;
    },
  });
  const ctx: any = { hasUI: true, mode: "tui", tools: [{ name: "write" }], executeTool() { executionCalls++; throw new Error("Must not execute"); } };
  try {
    const pending = tool.execute("request", { title: "A", why: "B", changes: [{ tool: "write", path: "a.ts", content: "a" }] }, new AbortController().signal, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await controller.review(ctx), true);
    assert.equal(reviewCalls, 1);
    assert.equal(focusCalls, 1);
    assert.equal(executionCalls, 0);
    decide({ action: "deny" });
    const result = await pending;
    assert.equal(result.details.status, "Denied");
    assert.equal(executionCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("toggling Pair reports disabled state and refreshes state when re-enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-lifecycle-test-"));
  const handlers = new Map<string, Function[]>();
  const entries: any[] = [];
  let command: any;
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {}, registerCommand(_name: string, definition: any) { command = definition; },
    getActiveTools: () => ["read", "grep", "find", "ls"], getAllTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx: any = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, setStatus() {}, notify() {}, confirm: async () => true } };
  pairExtension(pi);
  const start = async (prompt = "Continue") => {
    const results = [];
    for (const handler of handlers.get("before_agent_start") ?? []) results.push(await handler({ systemPrompt: "Host", messageType: "user", prompt }, ctx));
    return results.find((result) => result?.systemPrompt || result?.message);
  };
  try {
    await command.handler("on", ctx);
    const first = await start();
    assert.match(first.message.content, /enabled/);
    assert.equal((await start()).message, undefined, "unchanged state should not be duplicated");
    await command.handler("off", ctx);
    const disabled = await start();
    assert.match(disabled?.message?.content ?? "", /disabled|off/i);
    assert.ok(!disabled?.systemPrompt?.includes("Pair permissions are enabled"));
    await command.handler("on", ctx);
    assert.match((await start()).message.content, /enabled/);
    for (const handler of handlers.get("session_compact") ?? []) handler({}, ctx);
    assert.match((await start()).message.content, /enabled/, "compaction restoration should refresh the concise state");
    await start("Discussion only; preserve the current approval state and explain this design.");
    const guarded = async () => {
      const results = [];
      for (const handler of handlers.get("tool_call") ?? []) results.push(await handler({ toolName: "pair_step", input: {} }, ctx));
      return results.find((result) => result?.block);
    };
    assert.match((await guarded())?.reason ?? "", /explanation-only/);
    for (const handler of handlers.get("session_compact") ?? []) handler({}, ctx);
    assert.match((await guarded())?.reason ?? "", /explanation-only/, "automatic compaction must preserve a discussion-only run");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restoring a validation failure keeps the latest error visible without an execution grant", async () => {
  const handlers = new Map<string, Function[]>();
  let shown: { title: string; changes: any[]; readOnly: boolean | undefined } | undefined;
  let executions = 0;
  const previous = { type: "message", message: { role: "toolResult", toolName: "pair_step", details: {
    title: "Earlier successful edit", why: "A completed step", status: "Applied", changes: [
      { label: "earlier.ts", kind: "Edit", added: 1, removed: 0, diff: "+1 done" },
    ],
  }, content: [{ type: "text", text: "Applied" }] } };
  // Actual saved shape from Pi's schema-validation failure: truthy, empty details.
  const failure = { type: "message", message: { role: "toolResult", toolName: "pair_step", isError: true,
    details: {}, content: [{ type: "text", text: 'Validation failed for tool "pair_step": changes.2 is missing tool and path.' }],
  } };
  let branch = [previous, failure];
  const pi: any = { registerTool() {}, on(name: string, handler: Function) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  } };
  const controller = registerStepPermissions(pi, { active: () => ({ root: "unused" }), changed() {},
    review: async (_ctx, title, _why, changes, _signal, options) => {
      shown = { title, changes, readOnly: options?.readOnly };
      return { action: "deny" };
    },
  });
  const ctx: any = { cwd: process.cwd(), sessionManager: { getBranch: () => branch }, executeTool() { executions++; } };
  for (const event of ["session_start", "session_tree"]) {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
    assert.equal(await controller.review(ctx), true);
    assert.match(shown?.title ?? "", /Failed/);
    assert.ok(!shown?.title.includes("Earlier successful edit"));
    assert.equal(shown?.readOnly, true);
    assert.match(shown?.changes[0]?.text ?? "", /changes\.2/);
    assert.ok(controller.guard({ toolName: "write", input: { path: "a.ts", content: "x" } } as any)?.block);
  }
  assert.equal(executions, 0);
  branch = [];
  for (const handler of handlers.get("session_tree") ?? []) handler({}, ctx);
  assert.equal(await controller.review(ctx), false, "a different empty branch must not retain the previous error");
});
