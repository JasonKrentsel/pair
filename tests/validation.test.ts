import assert from "node:assert/strict";
import test from "node:test";
import pairExtension from "../extensions/pair/index.ts";

const tools = new Map<string, any>();
pairExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
const step = tools.get("pair_step").prepareArguments;
const work = tools.get("pair_work").prepareArguments;
const valid = { title: "Update file", why: "Use the selected configuration", changes: [{ tool: "write", path: "a.ts", content: "" }] };
function failure(prepare: (value: unknown) => unknown, value: unknown): string {
  try { prepare(value); assert.fail("Expected invalid arguments to be rejected"); }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Nothing ran\. Correct the fields and resubmit\./);
    assert.ok(error.message.length <= 700, error.message);
    assert.doesNotMatch(error.message, /Received arguments|anyOf|PRIVATE_SOURCE_MARKER/);
    return error.message;
  }
}

test("compact validation names the selected tool's fields without unrelated union alternatives", () => {
  const text = failure(step, { ...valid, changes: [{ tool: "edit", edits: [{ oldText: "a", newText: "b" }] }] });
  assert.match(text, /Change 1: missing path/);
  assert.doesNotMatch(text, /content|command/);
  const command = failure(step, { ...valid, changes: [{ tool: "powershell" }] });
  assert.match(command, /Change 1: missing command/);
});

test("nested replacements and size/range errors identify what must change", () => {
  const nested = failure(step, { ...valid, changes: [valid.changes[0], { tool: "edit", path: "b.ts", edits: [{ oldText: "a" }] }] });
  assert.match(nested, /Change 2\.edit 1: missing newText/);
  assert.match(failure(step, { ...valid, changes: [{ tool: "write", path: "a.ts", content: "PRIVATE_SOURCE_MARKER".repeat(4000) }] }), /content: use at most 60000 characters/);
  assert.match(failure(step, { ...valid, changes: [{ tool: "bash", command: "echo ok", timeout: 301 }] }), /timeout: must be at most 300/);
  assert.match(failure(step, { ...valid, changes: [{ tool: "edit", path: "a.ts", edits: [{ oldText: "", newText: "" }] }] }), /oldText: use at least 1/);
});

test("malformed root values and excessive groups fail before execution with bounded output", () => {
  for (const value of [null, [], "PRIVATE_SOURCE_MARKER", {}, { ...valid, changes: "PRIVATE_SOURCE_MARKER" }]) failure(step, value);
  assert.match(failure(step, { ...valid, changes: Array.from({ length: 5 }, () => ({ tool: "write", path: "a.ts", content: "x" })) }), /changes: include at most 4 items/);
  failure(step, { ...valid, title: {}, why: {}, changes: [null, {}, {}, {}] });
});

test("pair_work invalid actions and fields are concise and never echo submitted content", () => {
  assert.match(failure(work, { action: "PRIVATE_SOURCE_MARKER", text: "PRIVATE_SOURCE_MARKER".repeat(6000) }), /action: choose status, revise, design/);
  assert.match(failure(work, { action: "revise", target: "PRIVATE_SOURCE_MARKER" }), /target: choose design, increment/);
  assert.match(failure(work, { action: "design", text: 123 }), /text: expected string/);
});

test("valid inputs preserve exact source and legacy shorthand; ambiguous forms are rejected", () => {
  const change = { tool: "write", path: "a.ts", content: "\uFEFFconst text = '✓';\r\n" };
  const canonical = { ...valid, changes: [change] };
  assert.equal(step(canonical), canonical);
  assert.deepEqual(step({ title: valid.title, why: valid.why, change }), canonical);
  assert.match(failure(step, { ...canonical, change }), /not both/);
  assert.deepEqual(work({ action: "status" }), { action: "status" });
});
