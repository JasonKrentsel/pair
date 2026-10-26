import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-validation-runtime-"));
  let definition: any;
  const counts = { active: 0, hooks: 0, execute: 0, review: 0, native: 0 };
  let preview: any[] = [];
  const pi: any = { on() {}, appendEntry() {}, registerTool(tool: any) { definition = tool; } };
  registerStepPermissions(pi, {
    active: () => { counts.active++; return { root }; }, changed() {},
    review: async (_ctx, _title, _why, changes) => { counts.review++; preview = changes; return { action: "deny" }; },
  });
  const ctx: any = { hasUI: true, mode: "tui", tools: [{ name: "write" }],
    executeTool() { counts.native++; throw new Error("Native execution must remain behind permission"); },
  };
  const tool = { ...definition, execute: (...args: any[]) => { counts.execute++; return definition.execute(...args, ctx); } };
  const run = async (args: unknown) => {
    const call: any = { type: "toolCall", id: "request", name: "pair_step", arguments: args };
    return runToolCall(call, { tools: [tool], assistantMessage: { role: "assistant", content: [call] } as any,
      context: { messages: [], tools: [tool] },
      async beforeToolCall() { counts.hooks++; },
    });
  };
  return { root, counts, run, previews: () => preview, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("Pi's real tool-call pipeline returns compact errors before hooks, previews, or execution", async () => {
  const f = fixture();
  try {
    const marker = "source-that-must-not-be-echoed";
    const args = { title: "Add the runtime", why: "Run background agents.", changes: [
      { tool: "write", path: "a.ts", content: marker.repeat(1500) },
      { tool: "write", path: "b.ts", content: marker.repeat(1500) },
      { edits: [{ oldText: "before", newText: "after" }] },
    ] };
    const original = structuredClone(args);
    const outcome = await f.run(args);
    const message = outcome.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    assert.equal(outcome.isError, true);
    assert.match(message, /Change 3/);
    assert.match(message, /tool/);
    assert.match(message, /path/);
    assert.match(message, /Nothing ran/);
    assert.ok(message.length <= 700, `Error was ${message.length} characters`);
    assert.doesNotMatch(message, /Received arguments/);
    assert.ok(!message.includes(marker));
    assert.deepEqual(f.counts, { active: 0, hooks: 0, execute: 0, review: 0, native: 0 });
    assert.deepEqual(args, original, "Validation must not guess missing fields or alter proposed code");
    assert.equal(existsSync(join(f.root, "a.ts")), false);
  } finally { f.close(); }
});

test("valid legacy arguments still pass Pi validation and reach permission without executing", async () => {
  const f = fixture();
  try {
    const source = "\uFEFFconst answer = 42;\r\n";
    const outcome = await f.run({ title: "Add the answer", why: "Make the answer available.",
      change: { tool: "write", path: "answer.ts", content: source },
    });
    assert.equal(outcome.isError, false);
    assert.equal(outcome.result.details.status, "Denied");
    assert.deepEqual(f.counts, { active: 1, hooks: 1, execute: 1, review: 1, native: 0 });
    assert.equal(f.previews()[0].after, source);
    assert.equal(existsSync(join(f.root, "answer.ts")), false);
  } finally { f.close(); }
});
