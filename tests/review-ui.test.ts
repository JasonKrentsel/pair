import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { filePreview } from "../extensions/pair/changes.ts";
import { createReviewComponent, type PermissionDecision } from "../extensions/pair/review.ts";

initTheme("dark", false);
const json = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
const resolve = (color: string | number): string | number => typeof color === "string" && json.vars[color] !== undefined ? resolve(json.vars[color]) : color;
const theme = new Theme(Object.fromEntries(Object.entries(json.colors).map(([name, value]) => [name, resolve(value as string)])) as never, {} as never, "truecolor", { name: "fixture", appearance: "dark" });
const readable = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const source = Array.from({ length: 70 }, (_, i) => `export const item${i} = ${i};`).join("\n") + "\n";
const changes = [filePreview("src/answer.ts", source, source.replace("item2 = 2", "item2 = 200").replace("item50 = 50", "item50 = 500"), "Edit"), filePreview("src/new.ts", "", "export const next = 1;\n", "New file")];
function fixture(overrides: Record<string, unknown> = {}) {
  const decisions: PermissionDecision[] = [];
  const terminal = { columns: 110, rows: 36 };
  const tui = { terminal, requestRender() {}, getShowHardwareCursor: () => false } as unknown as TUI;
  const component = createReviewComponent({ title: "Share answer validation", why: "Use the same validation in both callers so incomplete responses fail visibly.", changes, theme, tui, done: (decision) => decisions.push(decision), ...overrides });
  return { component, terminal, decisions, render: () => component.render(terminal.columns - 4) };
}

test("commands fit their content and appear once", () => {
  const command = "npm run check";
  const f = fixture({ title: "Check the updated interfaces", changes: [{ label: command, command, cwd: "C:/project", kind: "bash", added: 0, removed: 0 }] });
  const lines = f.render();
  assert.equal(readable(lines).split(command).length - 1, 1);
  assert.ok(lines.length < 20, `short command used ${lines.length} rows`);
  assert.match(readable(lines), /Approve step · command/);
  assert.doesNotMatch(readable(lines), /Changes · \/ Search/);
});

test("saved validation errors open as read-only results without command actions", () => {
  const f = fixture({ title: "Failed · Change", why: "", readOnly: true,
    changes: [{ label: "Saved tool result", kind: "Result", added: 0, removed: 0,
      text: 'Validation failed for tool "pair_step": changes.2 is missing tool and path.' }],
  });
  const rendered = readable(f.render());
  assert.match(rendered, /Review · Saved result/);
  assert.match(rendered, /Validation failed/);
  assert.doesNotMatch(rendered, /Command|Approve/);
  f.component.handleInput("a");
  assert.equal(f.decisions.length, 0);
  f.component.handleInput("q");
  assert.deepEqual(f.decisions, [{ action: "deny" }]);
});

test("the note editor never mutates a host TUI forwarding proxy", () => {
  const terminal = { columns: 80, rows: 24 };
  const host = { terminal, requestRender() {}, getShowHardwareCursor: () => false };
  let writes = 0;
  const tui = new Proxy(host, { set(target, key, value) { writes++; return Reflect.set(target, key, value); } }) as unknown as TUI;
  const f = fixture({ tui });
  assert.equal(writes, 0);
  assert.equal(host.terminal, terminal);
  assert.equal(host.terminal.rows, 24);
  const lines = f.component.render(76);
  assert.match(readable(lines), /Approve/);
  assert.doesNotMatch(readable(lines), /resize to continue/);
  f.component.handleInput("n"); f.component.render(76);
  assert.equal(host.terminal.rows, 24);
});

test("normal and narrow viewports retain visible controls without overflowing", () => {
  const f = fixture();
  for (const [columns, rows] of [[80, 24], [110, 36], [160, 45]]) {
    f.terminal.columns = columns; f.terminal.rows = rows;
    const lines = f.render();
    assert.ok(lines.length <= rows - 4, `height overflow at ${columns}x${rows}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= columns - 4));
    assert.match(readable(lines), /Approve/);
    assert.match(readable(lines), /Deny/);
    assert.equal(f.component.state.canApprove, true);
  }
});

test("file navigation remembers independent scroll positions and hunk jumps", () => {
  const f = fixture(); f.terminal.rows = 24; f.render();
  f.component.handleInput("]"); f.render();
  const offset = f.component.state.offset;
  assert.ok(offset > 0);
  f.component.handleInput("\t"); f.render();
  assert.equal(f.component.state.selected, 1);
  assert.equal(f.component.state.offset, 0);
  f.component.handleInput("\x1b[Z"); f.render();
  assert.equal(f.component.state.selected, 0);
  assert.equal(f.component.state.offset, offset);
  assert.equal(f.decisions.length, 0);
});

test("note text cannot trigger approval, Escape returns to pending review", () => {
  const f = fixture(); f.render();
  f.component.handleInput("n"); f.render();
  f.component.handleInput("a"); f.component.handleInput("d");
  assert.equal(f.decisions.length, 0);
  assert.equal(f.component.state.mode, "note");
  assert.match(readable(f.render()), /ad/);
  f.component.handleInput("\x1b"); f.render();
  assert.equal(f.component.state.mode, "review");
  assert.equal(f.decisions.length, 0);
  f.component.handleInput("a");
  assert.deepEqual(f.decisions, [{ action: "approve" }]);
});

test("note submission returns exact feedback with denial", () => {
  const f = fixture(); f.render(); f.component.handleInput("n"); f.render();
  f.component.handleInput("Leave the CLI unchanged."); f.component.handleInput("\r");
  assert.deepEqual(f.decisions, [{ action: "deny", note: "Leave the CLI unchanged." }]);
});

test("tiny window disables approval and readonly views never approve", () => {
  const f = fixture(); f.terminal.columns = 32; f.terminal.rows = 12; f.render();
  f.component.handleInput("a"); assert.equal(f.decisions.length, 0);
  f.component.handleInput("d"); assert.deepEqual(f.decisions, [{ action: "deny" }]);
  const ro = fixture({ readOnly: true }); ro.render();
  ro.component.handleInput("a"); ro.component.handleInput("n");
  assert.equal(ro.decisions.length, 0); assert.equal(ro.component.state.mode, "review");
  ro.component.handleInput("q"); assert.deepEqual(ro.decisions, [{ action: "deny" }]);
});

test("search is local, has highlighted matches, and consumes decision keys", () => {
  const f = fixture(); f.terminal.rows = 24; f.render(); f.component.handleInput("/");
  f.component.handleInput("item50"); f.render();
  assert.equal(f.component.state.query, "item50");
  assert.equal(f.decisions.length, 0);
  f.component.handleInput("\r"); f.render();
  f.component.handleInput("f");
  assert.ok(f.component.state.offset > 0);
  assert.equal(f.decisions.length, 0);
});

test("mouse file selection and wheel scrolling match keyboard navigation", () => {
  const f = fixture(); f.terminal.rows = 24;
  const lines = f.render().map(stripTerminalSequences);
  const row = lines.findIndex((line) => line.includes("2 src/new.ts"));
  const col = lines[row].indexOf("2 src/new.ts");
  const mouse = (props: Partial<TuiMouseEvent>) => ({ type: "click", button: "left", x: col, y: row, screenX: col, screenY: row, width: 106, height: lines.length, shift: false, alt: false, ctrl: false, ...props }) as TuiMouseEvent;
  f.component.handleMouse(mouse({})); f.render();
  assert.equal(f.component.state.selected, 1);
  f.component.handleInput("1"); f.render();
  f.component.handleMouse(mouse({ type: "wheel", wheelDelta: 3 }));
  assert.ok(f.component.state.offset > 0);
  assert.equal(f.decisions.length, 0);
});

test("long notes keep the editor and proposal visible at 80 by 24", () => {
  const f = fixture(); f.terminal.columns = 80; f.terminal.rows = 24;
  f.render(); f.component.handleInput("n");
  f.component.handleInput("Please keep the interface unchanged. ".repeat(20));
  const lines = f.render();
  assert.ok(lines.length <= 20);
  assert.match(readable(lines), /Deny with note/);
  assert.match(readable(lines), /src\/answer.ts/);
  assert.match(readable(lines), /Enter Send denial/);
  assert.doesNotMatch(readable(lines), /resize to continue/);
});

test("external editor failure stays inside the pending review", async () => {
  const f = fixture({ onOpenExternal: async () => { throw new Error("code command unavailable"); } });
  f.render(); f.component.handleInput("v");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(readable(f.render()), /Could not open VS Code/);
  assert.equal(f.decisions.length, 0);
  assert.equal(f.component.state.mode, "review");
  assert.equal(f.component.state.canApprove, true);
});
