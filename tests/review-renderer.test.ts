import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { filePreview } from "../extensions/pair/changes.ts";
import { clearRenderCache, independentHighlightLines, renderChange } from "../extensions/pair/diff-view.ts";
import { normalizeStepDetails, renderStepCall, renderStepResult } from "../extensions/pair/history.ts";
import { displaySource, reviewHunks } from "../extensions/pair/review-model.ts";

initTheme("dark", false);
const json = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
const resolve = (color: string | number): string | number => typeof color === "string" && json.vars[color] !== undefined ? resolve(json.vars[color]) : color;
const colors = Object.fromEntries(Object.entries(json.colors).map(([name, value]) => [name, resolve(value as string)]));
const theme = new Theme(colors as never, colors as never, "truecolor", { name: "fixture", appearance: "dark" });
const readable = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("hunks retain exact before/proposed line numbers and distant changes", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 2\n", "new line 2\n").replace("line 26\n", "new line 26\n");
  const hunks = reviewHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].lines.find((line) => line.kind === "remove")?.oldLine, 2);
  assert.equal(hunks[1].lines.find((line) => line.kind === "add")?.newLine, 26);
  const rendered = renderChange(filePreview("file.txt", before, after, "Edit"), theme, 80);
  assert.equal(rendered.hunks.length, 2);
  for (const [i, row] of rendered.hunks.entries()) assert.match(readable([rendered.lines[row]]), new RegExp(`Change ${i + 1}/2`));
});

test("narrow unicode and long-line views keep every rendered row within its width", () => {
  const change = filePreview("src/很长的文件名.ts", "const text = 'old';\n", `const text = '${"你好🙂 abc ".repeat(25)}';\n`, "Edit");
  for (const width of [1, 12, 32, 60, 80, 110, 160]) {
    for (const wrap of [true, false]) {
      const rendered = renderChange(change, theme, width, { wrap, layout: "auto" });
      assert.ok(rendered.lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}, wrap=${wrap}`);
      if (width < 110) assert.equal(rendered.layout, "unified");
    }
  }
});

test("split view adapts to width, balance, and wrapping", () => {
  const change = filePreview("src/answer.ts", "export const answer = 41;\n", "export const answer = 42;\n", "Edit");
  assert.equal(renderChange(change, theme, 160).layout, "split");
  assert.equal(renderChange(change, theme, 80, { layout: "split" }).layout, "unified");
  assert.equal(renderChange(filePreview("new.ts", "", "const a = 1;\n", "New file"), theme, 160).layout, "unified");
  const long = filePreview("a.ts", "const a = '" + "x".repeat(160) + "';\n", "const a = '" + "y".repeat(160) + "';\n", "Edit");
  assert.equal(renderChange(long, theme, 160).layout, "unified");
});

test("word changes add emphasis without removing source syntax colors", () => {
  const change = filePreview("a.ts", "export const answer = 41;\n", "export const answer = 42;\n", "Edit");
  const rendered = renderChange(change, theme, 80);
  const line = rendered.lines.find((row) => stripTerminalSequences(row).includes("42"))!;
  assert.match(line, /\x1b\[38;[25];/); // Syntax foreground.
  const backgrounds = new Set([...line.matchAll(/\x1b\[48;[25];[\d;]+m/g)].map((match) => match[0]));
  assert.ok(backgrounds.size >= 2, "line tint and changed-word emphasis should be distinct");
});

test("multiline syntax state is restored at the start of each independent row", () => {
  const lines = independentHighlightLines(["\x1b[38;2;20;30;40m/* first", "second */\x1b[39m const x = 1;"]);
  assert.ok(lines[1].startsWith("\x1b[38;2;20;30;40m"));
  assert.equal(stripTerminalSequences(lines[1]), "second */ const x = 1;");
});

test("terminal control characters in source are visible inert text", () => {
  assert.equal(displaySource("\x1b[2J\x07"), "\\x1b[2J\\x07");
  const rendered = renderChange(filePreview("test.txt", "", "\x1b[2J\x07", "New file"), theme, 80);
  assert.ok(!rendered.lines.join("\n").includes("\x1b[2J"));
  assert.match(readable(rendered.lines), /\\x1b\[2J\\x07/);
});

test("command renders once and a short command needs no padding", () => {
  const rendered = renderChange({ label: "git status --short", kind: "bash", command: "git status --short", cwd: "C:\\demo", added: 0, removed: 0 }, theme, 80);
  assert.equal((readable(rendered.lines).match(/git status --short/g) ?? []).length, 1);
  assert.equal(rendered.lines.length, 2);
});

test("newline and BOM changes remain explicit, while snapshots remain byte-exact", () => {
  const change = filePreview("a.txt", "\uFEFFhello\r\n", "hello\n", "Edit");
  assert.equal(change.before, "\uFEFFhello\r\n");
  assert.equal(change.after, "hello\n");
  const text = readable(renderChange(change, theme, 80).lines);
  assert.match(text, /BOM removed/);
  assert.match(text, /CRLF → LF/);
});

test("search identifies visible matching rows and cache invalidation preserves source", () => {
  const change = filePreview("a.ts", "const a = 1;\n", "const searchMe = 2;\n", "Edit");
  const first = renderChange(change, theme, 80, { query: "searchMe" });
  assert.equal(first.matches.length, 1);
  assert.match(readable([first.lines[first.matches[0]]]), /searchMe/);
  clearRenderCache();
  assert.equal(readable(renderChange(change, theme, 80).lines), readable(first.lines));
  change.after = "const changed = 3;\n";
  assert.match(readable(renderChange(change, theme, 80).lines), /changed/);
});

test("a search term crossing a wrapped row still has navigable matches", () => {
  const change = filePreview("a.txt", "", "1234567890abcdefghijklmnopqrstuvwxyz\n", "New file");
  const rendered = renderChange(change, theme, 25, { query: "abcdefghijklmnopqrstuvwxyz" });
  assert.ok(rendered.matches.length >= 2);
});

test("collapsed history contains the result and file stats, expanded history contains the code", () => {
  const change = filePreview("answer.ts", "const oldAnswer = 1;\n", "const newAnswer = 2;\n", "Edit");
  const result = { content: [{ type: "text" as const, text: "Applied." }], details: { title: "Update answer", why: "Use the corrected value.", status: "Applied", changes: [change] } };
  const context = { outputPad: 0, isError: false };
  const collapsed = readable(renderStepResult(result, { expanded: false, isPartial: false }, theme, context).render(80));
  assert.match(collapsed, /Applied/);
  assert.match(collapsed, /answer.ts · \+1 −1/);
  assert.doesNotMatch(collapsed, /newAnswer/);
  const expanded = readable(renderStepResult(result, { expanded: true, isPartial: false }, theme, context).render(80));
  assert.match(expanded, /newAnswer/);
});

test("saved validation failures with empty details remain readable in both history views", () => {
  // Shape of Pi's persisted schema failure in session entry 6be4be9c. The full
  // provider-generated arguments are intentionally replaced with a small sample.
  const result = {
    details: {},
    content: [{ type: "text" as const, text: 'Validation failed for tool "pair_step":\n  - changes.2.tool: must have required properties tool, path\nReceived arguments:\n{"changes":[{"edits":[]}]}' }],
  };
  for (const expanded of [false, true]) {
    const rendered = readable(renderStepResult(result, { expanded, isPartial: false }, theme, { outputPad: 0, isError: true }).render(80));
    assert.match(rendered, /^Failed\n/);
    assert.match(rendered, /Validation failed for tool "pair_step"/);
    assert.match(rendered, /changes\.2\.tool/);
    assert.doesNotMatch(rendered, /Applied/);
    if (expanded) assert.match(rendered, /"edits":\[\]/);
  }
});

test("legacy patch results and denial notes retain their recorded outcome", () => {
  const details = { title: "Update source", why: "Load the prompt separately.", status: "Done", patch: "--- old\n+++ new\n-old\n+new", output: "Successfully replaced 1 block(s)." };
  const result = { details, content: [{ type: "text" as const, text: details.output }] };
  const rendered = readable(renderStepResult(result, { expanded: true, isPartial: false }, theme, { outputPad: 0, isError: false }).render(80));
  assert.match(rendered, /^Applied\n/);
  assert.match(rendered, /\+new/);
  assert.match(rendered, /Successfully replaced/);
  const denied = { details: { title: "Adjust config", status: "Denied — not run", note: "Keep it in the project root." }, content: [] };
  const denial = readable(renderStepResult(denied, { expanded: false, isPartial: false }, theme, { outputPad: 0, isError: false }).render(80));
  assert.match(denial, /Denied — not run/);
  assert.match(denial, /Your note: Keep it in the project root\./);
});

test("unrecognized persisted metadata cannot crash history or claim successful execution", () => {
  for (const details of [undefined, null, {}, [], 12, { status: {}, why: 1, changes: "invalid" }, { changes: [null, {label: 3, before: 4, after: [], added: "1", removed: -1}] }]) {
    const result = { details, content: [{ type: "text" as const, text: "Recorded tool output" }] };
    for (const expanded of [false, true]) {
      const rows = renderStepResult(result, { expanded, isPartial: false }, theme, { outputPad: 0, isError: false }).render(60);
      const rendered = readable(rows);
      assert.match(rendered, /Recorded result/);
      assert.match(rendered, /Recorded tool output/);
      assert.doesNotMatch(rendered, /Applied|undefined|NaN/);
      assert.ok(rows.every((row) => visibleWidth(row) <= 60));
    }
  }
  assert.match(readable(renderStepCall(undefined, theme, { outputPad: 0, isError: false }).render(60)), /Preparing/);
});

test("partial results stay pending and normalization preserves exact saved snapshots", () => {
  const pending = renderStepResult({ details: {}, content: [] }, { expanded: false, isPartial: true }, theme, { outputPad: 0, isError: false });
  assert.equal(readable(pending.render(60)), "Preparing step");
  const original = { title: "Edit", status: "Applied", changes: [{ label: "a.ts", kind: "Edit", before: "\uFEFFold\r\n", after: "new\n", added: 1, removed: 1 }] };
  const normalized = normalizeStepDetails(original);
  assert.equal(normalized.changes?.[0].before, original.changes[0].before);
  assert.equal(normalized.changes?.[0].after, original.changes[0].after);
  assert.notEqual(normalized.changes?.[0], original.changes[0]);
});
