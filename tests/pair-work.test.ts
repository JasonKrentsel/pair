import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pairExtension from "../extensions/pair/index.ts";
import { STATE_ENTRY } from "../extensions/pair/state.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-work-test-"));
  const handlers = new Map<string, Function[]>();
  const entries: any[] = [];
  const tools = new Map<string, any>();
  let command: any;
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(_name: string, definition: any) { command = definition; },
    getActiveTools: () => ["read", "grep", "find", "ls"], getAllTools: () => [], setActiveTools() {},
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx: any = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, setStatus() {}, notify() {} },
  };
  pairExtension(pi);
  await command.handler("on", ctx);
  const current = () => entries.filter((entry) => entry.customType === STATE_ENTRY).at(-1).data;
  const run = (args: any) => tools.get("pair_work").execute("work", args, undefined, undefined, ctx);
  const restore = async (state: any) => {
    entries.push({ type: "custom", customType: STATE_ENTRY, data: state });
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  };
  return { root, entries, current, run, restore, close: () => rmSync(root, { recursive: true, force: true }) };
}
const content = (result: any) => result.content.map((block: any) => block.text ?? "").join("\n");

test("pair_work status returns concise facts and does not change saved state", async () => {
  const f = await fixture();
  try {
    const count = f.entries.length;
    const first = await f.run({ action: "status" });
    const second = await f.run({ action: "status" });
    assert.equal(content(first), content(second));
    assert.equal(f.entries.length, count);
    assert.match(content(first), /Pair: on/);
    assert.match(content(first), /Design: none saved/);
    assert.ok(content(first).length < 150);
    assert.doesNotMatch(content(first), /pair_step|Approve all|Deny|Routine|human limits/);
    assert.equal(first.details.markdown, content(first));
  } finally { f.close(); }
});

test("pair_work design receipts preserve full design in UI details and approval transitions", async () => {
  const f = await fixture();
  try {
    const design = "# Design\n\n" + "DESIGN_BODY_ONLY_IN_UI\n".repeat(300);
    const published = await f.run({ action: "design", text: design });
    const disk = readFileSync(join(f.root, "docs/design/pair.md"), "utf8");
    assert.equal(disk, design.trim() + "\n");
    assert.equal(published.details.markdown, disk);
    assert.match(content(published), /Design published/);
    assert.match(content(published), /revision 1 · awaiting approval/);
    assert.doesNotMatch(content(published), /DESIGN_BODY_ONLY_IN_UI|pair_step/);
    assert.ok(content(published).length < 160);
    assert.equal(f.current().design.approvedRevision, undefined);

    // Restore the same shape recorded after a human approves the design.
    await f.restore({ ...f.current(), phase: "proposal", design: { ...f.current().design, approvedRevision: 1 } });
    const approved = await f.run({ action: "status" });
    assert.match(content(approved), /revision 1 · approved/);
    await assert.rejects(f.run({ action: "design", text: "# Revised" }), /reopen the draft first/);
    const reopened = await f.run({ action: "revise", target: "design", text: "Use one async spawn path." });
    assert.match(content(reopened), /Design reopened; approval cleared/);
    assert.match(content(reopened), /revision 1 · draft/);
    assert.equal(f.current().design.approvedRevision, undefined);
    assert.equal(readFileSync(join(f.root, "docs/design/pair.md"), "utf8"), disk);
    const revised = await f.run({ action: "design", text: "# Revised\nOne async spawn path." });
    assert.match(content(revised), /revision 2 · awaiting approval/);
    assert.equal(f.current().design.approvedRevision, undefined);
    assert.equal(revised.details.markdown, "# Revised\nOne async spawn path.\n");
  } finally { f.close(); }
});

test("legacy review receipts include useful facts without repeating snapshots or long notes", async () => {
  const f = await fixture();
  try {
    const increment = { id: "saved", revision: 1, title: "Earlier review", approvedRevision: 1,
      behavior: "PRIVATE_PLAN_BODY".repeat(1000), approach: "Implementation", files: [], verification: "Checks",
      commands: [], baseline: {}, expected: {}, summary: "Completed", checks: "Passed", deviations: "None" };
    await f.restore({ ...f.current(), goal: "A very long goal ".repeat(100), increment, phase: "review" });
    const revised = await f.run({ action: "revise", target: "increment", text: "Keep the CLI open-ended. ".repeat(100) });
    assert.match(content(revised), /Saved review reopened; approval cleared/);
    assert.match(content(revised), /Earlier review/);
    assert.equal(f.current().increment.approvedRevision, undefined);
    assert.equal(f.current().phase, "paused");
    const status = await f.run({ action: "status" });
    assert.match(content(status), /Saved review: Earlier review \(reference only\)/);
    assert.match(content(status), /Keep the CLI open-ended/);
    assert.ok(content(status).length < 600);
    assert.doesNotMatch(content(status), /PRIVATE_PLAN_BODY|baseline|pair_step|Deny/);
  } finally { f.close(); }
});
