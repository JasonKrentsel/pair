import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { prepareChanges } from "../extensions/pair/changes.ts";
import { buildActionRevision } from "../extensions/pair/action-revisions.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pair-action-revision-"));
  return { root, file: (name: string) => join(root, name), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("scoped new-file revision preserves BOM, CRLF and all unselected bytes without writing", async () => {
  const f = fixture();
  try {
    const original = "\uFEFFexport function message() {\r\n  return 'old';\r\n}\r\nexport const protocol = 'v1';\r\n";
    const prepared = await prepareChanges(f.root, [{ tool: "write", path: "a.ts", content: original, why: "Create the module.", annotations: [{ title: "Old note", why: "Explain old return.", startLine: 2, endLine: 2 }] }, { tool: "powershell", command: "npm test", timeout: 25, interactive: true, why: "Verify the module." }]);
    const serialized = JSON.stringify(prepared);
    const next = await buildActionRevision(f.root, prepared, 0, "  const value = 'new';\n  return value;\n", "Keep the protocol and simplify the return.", { startLine: 2, endLine: 2 });
    assert.equal(next.length, 2); assert.equal(next[1], prepared[1]); assert.equal(JSON.stringify(prepared), serialized);
    assert.equal(next[0].tool, "write"); assert.equal(next[0].path, prepared[0].path); assert.equal(next[0].before, prepared[0].before);
    assert.equal(next[0].after, "\uFEFFexport function message() {\r\n  const value = 'new';\r\n  return value;\r\n}\r\nexport const protocol = 'v1';\r\n");
    assert.equal(next[0].preview.annotations, undefined); assert.equal(existsSync(f.file("a.ts")), false);
  } finally { f.close(); }
});

test("edit revision composes against original disk baseline and executes exactly through native edit", async () => {
  const f = fixture();
  try {
    const before = "export const protocol = 'v1';\nexport function read() {\n  return 'before';\n}\n";
    writeFileSync(f.file("a.ts"), before);
    const prepared = await prepareChanges(f.root, [{ tool: "edit", path: "a.ts", edits: [{ oldText: "return 'before'", newText: "return 'original proposal'" }], why: "Use a better implementation." }]);
    const next = await buildActionRevision(f.root, prepared, 0, "  return 'human revision';", "Use the preferred internal behavior.", { startLine: 3, endLine: 3 });
    assert.equal(next[0].tool, "edit"); assert.equal(next[0].before, prepared[0].before);
    assert.equal(readFileSync(f.file("a.ts"), "utf8"), before, "revision preparation must not write");
    assert.match(JSON.stringify(next[0].input.edits), /before/); assert.doesNotMatch(JSON.stringify(next[0].input.edits), /original proposal/);
    await createEditTool(f.root).execute("approved-test", next[0].input as any);
    assert.equal(readFileSync(f.file("a.ts"), "utf8"), next[0].after);
    assert.match(next[0].after!, /^export const protocol = 'v1';/);
  } finally { f.close(); }
});

test("large files keep small separate native replacements instead of rewriting the file", async () => {
  const f = fixture();
  try {
    const before = Array.from({ length: 5000 }, (_, i) => `export const value${i} = ${i};\n`).join("");
    writeFileSync(f.file("large.ts"), before);
    const prepared = await prepareChanges(f.root, [{ tool: "edit", path: "large.ts", edits: [{ oldText: "value100 = 100", newText: "value100 = 101" }, { oldText: "value4500 = 4500", newText: "value4500 = 4501" }], why: "Adjust two independent constants." }]);
    const next = await buildActionRevision(f.root, prepared, 0, "export const value100 = 102;", "Use the preferred first value.", { startLine: 101, endLine: 101 });
    const edits = next[0].input.edits as Array<{ oldText: string; newText: string }>;
    assert.equal(edits.length, 2); assert.ok(edits.every(edit => edit.oldText.length < 200 && edit.newText.length < 200));
    assert.match(next[0].after!, /value4500 = 4501/);
    await createEditTool(f.root).execute("approved-test", next[0].input as any);
    assert.equal(readFileSync(f.file("large.ts"), "utf8"), next[0].after);
  } finally { f.close(); }
});

test("insertions and repeated source lines receive unique nonoverlapping anchors", async () => {
  const f = fixture();
  try {
    const before = "function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n";
    writeFileSync(f.file("a.ts"), before);
    const prepared = await prepareChanges(f.root, [{ tool: "edit", path: "a.ts", edits: [{ oldText: "function second() {\n  return 1;", newText: "function second() {\n  return 2;" }], why: "Change the second implementation." }]);
    const next = await buildActionRevision(f.root, prepared, 0, "// Chosen behavior\nfunction first() {\n  return 1;\n}\nfunction second() {\n  const answer = 3;\n  return answer;\n}\n", "Name the intermediate value.");
    await createEditTool(f.root).execute("approved-test", next[0].input as any);
    assert.equal(readFileSync(f.file("a.ts"), "utf8"), next[0].after);
  } finally { f.close(); }
});

test("command revisions preserve shell, execution mode, timeout and siblings", async () => {
  const f = fixture();
  try {
    const prepared = await prepareChanges(f.root, [{ tool: "powershell", command: "Write-Host before\r\nnpm test\r\nWrite-Host after", timeout: 25, interactive: true, why: "Check the application." }, { tool: "write", path: "after.txt", content: "Keep this unchanged", why: "Record the result." }]);
    const next = await buildActionRevision(f.root, prepared, 0, "npm run check\n", "Run the focused type check.", { startLine: 2, endLine: 2 });
    assert.deepEqual(next[0].input, { command: "Write-Host before\r\nnpm run check\r\nWrite-Host after", timeout: 25, interactive: true });
    assert.equal(next[0].tool, "powershell"); assert.equal(next[1], prepared[1]);
    assert.equal(existsSync(f.file("after.txt")), false);
  } finally { f.close(); }
});

test("stale files anywhere in the step prevent revision rather than silently rebasing", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file("later.ts"), "before\n");
    const prepared = await prepareChanges(f.root, [{ tool: "bash", command: "npm test", why: "Check." }, { tool: "edit", path: "later.ts", edits: [{ oldText: "before", newText: "proposed" }], why: "Wire it later." }]);
    writeFileSync(f.file("later.ts"), "human edit\n");
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "npm run check", "Use the focused check."), /changed since the preview/);
    assert.equal(readFileSync(f.file("later.ts"), "utf8"), "human edit\n");
  } finally { f.close(); }
});

test("malformed, no-op, excessive, cancelled, and disk-racing revisions never produce candidates", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file("a.ts"), "const answer = 1;\n");
    const prepared = await prepareChanges(f.root, [{ tool: "edit", path: "a.ts", edits: [{ oldText: "answer = 1", newText: "answer = 2" }], why: "Correct it." }]);
    await assert.rejects(buildActionRevision(f.root, prepared, -1, "x", "Fix"), /Choose one action/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "x", "Fix", { startLine: 0, endLine: 1 }), /existing proposed lines/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "x", "Fix", { startLine: 2, endLine: 99 }), /existing proposed lines/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, prepared[0].after!, "Fix"), /does not change/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "\0", "Fix"), /UTF-8 text/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "\ud800", "Fix"), /UTF-8 text/);
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "x".repeat(270000), "Fix"), /256 KiB/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(buildActionRevision(f.root, prepared, 0, "x", "Fix", undefined, aborted.signal), /abort/i);
    const candidate = buildActionRevision(f.root, prepared, 0, "const answer = 3;\n", "Fix");
    queueMicrotask(() => writeFileSync(f.file("a.ts"), "human changed it\n"));
    await assert.rejects(candidate, /changed since the preview/);
    assert.equal(readFileSync(f.file("a.ts"), "utf8"), "human changed it\n");
  } finally { f.close(); }
});
