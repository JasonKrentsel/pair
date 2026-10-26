import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { filePreview } from "../extensions/pair/changes.ts";
import { showPermission } from "../extensions/pair/ui.ts";

initTheme("dark", false);
const palette = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
const color = (value: string | number): string | number => typeof value === "string" && palette.vars[value] !== undefined ? color(palette.vars[value]) : value;
const colors = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) => [key, color(value as string)]));
const theme = new Theme(colors as never, colors as never, "truecolor", { name: "overlay-test", appearance: "dark" });

test("the native overlay keeps large-diff controls visible through terminal resize and End/PageDown", async () => {
  const terminal = { columns: 80, rows: 24, write() {}, hideCursor() {}, showCursor() {}, stop() {} };
  const tui = new TuiAltScreen(terminal as any, false);
  // Exercise the real compositor without starting a terminal or scheduling paints.
  tui.stop();
  let component: any;
  let resolveDecision: (value: any) => void = () => {};
  const ctx: any = { ui: { custom(factory: any, options: any) {
    component = factory(tui, theme, {}, (decision: any) => resolveDecision(decision));
    // Pi 1.4 resolves this callback once when opening, not after each resize.
    const overlayOptions = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
    tui.showOverlay(component, overlayOptions);
    return new Promise((resolve) => { resolveDecision = resolve; });
  } } };
  const source = Array.from({ length: 220 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n// FINAL_REVIEW_LINE\n";
  const pending = showPermission(ctx, "Add the reviewed module", "Keep the implementation readable.", [filePreview("src/module.ts", "", source, "New file")]);
  const screen = () => (tui as any).compositeOverlays(Array.from({ length: terminal.rows }, () => ""), terminal.columns, terminal.rows).map(stripTerminalSequences).join("\n");
  try {
    for (const [columns, rows] of [[80, 24], [110, 36], [160, 45], [80, 24], [160, 45]]) {
      terminal.columns = columns; terminal.rows = rows;
      assert.match(screen(), /\[a\] Approve/, `approval hidden at ${columns}x${rows}`);
      component.handleInput("\x1b[F"); // End
      const last = screen();
      assert.match(last, /FINAL_REVIEW_LINE/, `last line unreachable at ${columns}x${rows}`);
      assert.match(last, /\[a\] Approve/);
      assert.match(last, /\[d\] Deny/);
      assert.match(last, /╰─/);
      component.handleInput("\x1b[H"); // Home
      screen();
      for (let page = 0; page < 120; page++) { component.handleInput("\x1b[6~"); screen(); }
      assert.match(screen(), /FINAL_REVIEW_LINE/);
      assert.match(screen(), /\[n\] Deny with note/);
    }
  } finally {
    component.handleInput("d");
    await pending;
    tui.stop();
  }
});
