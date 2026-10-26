import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createCheckpointComponent, type CheckpointAction } from "../extensions/pair/checkpoint-ui.ts";
import { addConstraint, markCheckpointStale, normalizeMemory, updateCheckpoint } from "../extensions/pair/checkpoint.ts";

initTheme("dark", false);
const palette = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
const color = (value: string | number): string | number => typeof value === "string" && palette.vars[value] !== undefined ? color(palette.vars[value]) : value;
const colors = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) => [key, color(value as string)]));
const theme = new Theme(colors as never, colors as never, "truecolor", { name: "checkpoint-test", appearance: "dark" });

function fixture(populated = true) {
  const terminal = { columns: 80, rows: 24 };
  let memory = normalizeMemory(undefined);
  if (populated) {
    memory = updateCheckpoint(memory, { objective: "Worker recovery", implemented: "A serialized checkpoint writer. ".repeat(12), verification: "23 scripted tests passed before later edits", usable: "Internal tests only", deferred: "CLI integration by the human's request", next: "Resume a run by ID" });
    for (let index = 0; index < 12; index++) memory = addConstraint(memory, `Constraint ${index}: preserve the chosen API and explain changes clearly.`, index % 2 ? "turn" : "task");
    memory = markCheckpointStale(memory);
  }
  const actions: CheckpointAction[] = [];
  const component = createCheckpointComponent({ memory, goal: "Pair programming", theme, tui: { terminal, requestRender() {} } as unknown as TUI, done: action => actions.push(action) });
  const lines = () => component.render(terminal.columns - 4);
  const render = () => lines().map(stripTerminalSequences).join("\n");
  return { terminal, component, actions, lines, render };
}

test("checkpoint reader keeps controls and final constraints visible across resize and scrolling", () => {
  const f = fixture();
  for (const [columns, rows] of [[80, 24], [110, 36], [160, 45], [80, 24]]) {
    f.terminal.columns = columns; f.terminal.rows = rows;
    assert.ok(f.lines().length <= rows - 4);
    assert.ok(f.lines().every(line => visibleWidth(line) <= Math.min(110, columns - 4)));
    assert.match(f.render(), /\[a\] Add constraint/);
    f.component.handleInput("\x1b[F");
    assert.match(f.render(), /Constraint 11/);
    assert.match(f.render(), /\[r\] Remove/);
    assert.match(f.render(), /no execution permission/);
    f.component.handleInput("\x1b[H");
    assert.match(f.render(), /Current objective/);
    assert.match(f.render(), /Later actions occurred/);
  }
});

test("missing checkpoint remains explicitly unknown and has no approval action", () => {
  const f = fixture(false);
  const text = f.render();
  assert.match(text, /No checkpoint recorded/);
  assert.match(text, /Not recorded/);
  assert.doesNotMatch(text, /Approve|\[r\]/);
  f.component.handleInput("a");
  assert.deepEqual(f.actions, ["add"]);
});

test("small viewports suppress hidden constraint actions but remain closable", () => {
  const f = fixture();
  f.terminal.columns = 35; f.terminal.rows = 12;
  assert.match(f.render(), /Resize to read/);
  f.component.handleInput("a"); f.component.handleInput("r");
  assert.equal(f.actions.length, 0);
  f.component.handleInput("\x1b");
  assert.deepEqual(f.actions, ["close"]);
});
