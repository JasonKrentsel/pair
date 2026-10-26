// Read-only compatibility audit. Never opens a session, runs a tool, or calls a model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import pairExtension from "../extensions/pair/index.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: node --import ./scripts/pi-runtime.mjs scripts/replay-session.ts path/to/session.jsonl");
const original = readFileSync(path);
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const entries = original.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
initTheme("dark", false);
const palette = JSON.parse(readFileSync(join(getPackageDir(), "dist/modes/interactive/theme/dark.json"), "utf8"));
const color = (value: string | number): string | number => typeof value === "string" && palette.vars[value] !== undefined ? color(palette.vars[value]) : value;
const colors = Object.fromEntries(Object.entries(palette.colors).map(([key, value]) => [key, color(value as string)]));
const theme = new Theme(colors as never, colors as never, "truecolor", { name: "replay", appearance: "dark" });
const definitions = new Map<string, any>();
pairExtension({ on() {}, registerCommand() {}, registerTool(tool: any) { definitions.set(tool.name, tool); } } as any);
let calls = 0, results = 0, frames = 0;
for (const entry of entries) {
  if (entry.type !== "message") continue;
  const message = entry.message;
  if (message.role === "assistant") {
    for (const call of (Array.isArray(message.content) ? message.content : []).filter((item: any) => item.type === "toolCall" && definitions.has(item.name))) {
      for (const width of [60, 80, 160]) {
        const rows = definitions.get(call.name).renderCall(call.arguments, theme, { outputPad: 0, isError: false }).render(width);
        assert.ok(rows.every((row: unknown) => typeof row === "string"), `${entry.id}: non-text call row`);
        frames++;
      }
      calls++;
    }
  } else if (message.role === "toolResult" && definitions.has(message.toolName)) {
    for (const expanded of [false, true]) for (const width of [60, 80, 160]) {
      const rows = definitions.get(message.toolName).renderResult(message, { expanded, isPartial: false }, theme, { outputPad: 0, isError: message.isError === true }).render(width);
      assert.ok(rows.every((row: unknown) => typeof row === "string"), `${entry.id}: non-text result row`);
      assert.ok(rows.every((row: string) => visibleWidth(row) <= width), `${entry.id}: result exceeds ${width} columns`);
      frames++;
    }
    results++;
  }
}
assert.equal(digest(readFileSync(path)), digest(original), "Session changed during replay");
console.log(JSON.stringify({ calls, results, frames, sessionUnchanged: true, modelCalls: 0, toolExecutions: 0 }));
