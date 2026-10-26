import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { normalizeMemory, type WorkMemory } from "./checkpoint.ts";

export type CheckpointAction = "close" | "add" | "remove";
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function age(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "Update time not recorded";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  return minutes === 0 ? "Updated just now" : minutes < 60 ? `Updated ${minutes}m ago` : minutes < 1440 ? `Updated ${Math.floor(minutes / 60)}h ago` : `Updated ${Math.floor(minutes / 1440)}d ago`;
}

export function createCheckpointComponent(options: { memory: WorkMemory; goal: string; theme: Theme; tui: Pick<TUI, "terminal" | "requestRender">; done: (action: CheckpointAction) => void }) {
  const memory = normalizeMemory(options.memory);
  const checkpoint = memory.checkpoint;
  const { theme, tui } = options;
  let offset = 0, pageSize = 1, maxOffset = 0, controlsVisible = false;
  let finished = false;
  const finish = (action: CheckpointAction) => { if (!finished) { finished = true; options.done(action); } };

  return {
    render(width: number): string[] {
      const available = Math.max(1, Math.min(width, 110));
      const rows = Math.max(1, tui.terminal.rows - 4);
      controlsVisible = available >= 38 && rows >= 12;
      if (!controlsVisible) return [theme.fg("accent", truncateToWidth("Pair checkpoint", available)), truncateToWidth("Resize to read · Esc Close", available)].slice(0, rows);
      const inside = available - 4;
      const wrap = (value: string) => plain(value).split("\n").flatMap(line => wrapTextWithAnsi(line, inside));
      const heading = (label: string) => theme.bold(theme.fg("accent", label));
      const content: string[] = [];
      const section = (label: string, value: string | undefined) => { content.push(heading(label), ...wrap(value?.trim() || "Not recorded"), ""); };
      section("Current objective", checkpoint?.objective || options.goal);
      if (checkpoint?.stale) content.push(...wrap("Later actions occurred after this checkpoint. Its verification and progress may need an update.").map(line => theme.fg("warning", line)), "");
      section("Implemented", checkpoint?.implemented);
      section("Verification · agent report", checkpoint?.verification);
      section("Usable now", checkpoint?.usable);
      section("Deferred", checkpoint?.deferred);
      section("Next decision", checkpoint?.next);
      content.push(heading("Pinned human constraints"));
      if (!memory.constraints.length) content.push(...wrap("None pinned. Direct instructions in chat still apply."));
      else for (const item of memory.constraints) {
        content.push(...wrap(`[${item.scope === "task" ? "This task" : item.pendingTurn ? "Next turn" : "This turn"}] ${item.text}`), "");
      }
      content.push("", ...wrap("Task constraints remain until removed or new Pair work starts. Turn constraints cover the current run; those added while idle cover the next run. They expire when another chat turn starts. These instructions grant no execution permission.").map(line => theme.fg("muted", line)));
      const controls = `[a] Add constraint${memory.constraints.length ? " · [r] Remove" : ""} · Esc Close`;
      const footer = [...wrap(controls).map(line => theme.fg("accent", line)), ...wrap("↑/↓ Scroll · PgUp/PgDn · Home/End").map(line => theme.fg("muted", line))];
      const header = [theme.bold("Checkpoint & constraints"), theme.fg("muted", checkpoint ? `Agent-reported · revision ${checkpoint.revision} · ${age(checkpoint.updatedAt)}` : "No checkpoint recorded yet")].flatMap(line => wrapTextWithAnsi(line, inside));
      // Border + header separator + position + footer separator are fixed rows.
      pageSize = Math.max(1, rows - header.length - footer.length - 5);
      maxOffset = Math.max(0, content.length - pageSize);
      offset = Math.max(0, Math.min(offset, maxOffset));
      const body = content.slice(offset, offset + pageSize);
      const horizontal = theme.fg("dim", "─".repeat(available - 2));
      const framed = (line: string) => theme.fg("dim", "│") + " " + truncateToWidth(line, inside, "", true) + " " + theme.fg("dim", "│");
      return [
        theme.fg("dim", "╭") + horizontal + theme.fg("dim", "╮"),
        ...header.map(framed), framed(theme.fg("dim", "─".repeat(inside))),
        ...body.map(framed),
        framed(theme.fg("muted", `Lines ${offset + 1}–${Math.min(offset + pageSize, content.length)} of ${content.length}`)),
        framed(theme.fg("dim", "─".repeat(inside))), ...footer.map(framed),
        theme.fg("dim", "╰") + horizontal + theme.fg("dim", "╯"),
      ];
    },
    handleInput(data: string) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return finish("close");
      if (!controlsVisible) return;
      if (data === "a") return finish("add");
      if (data === "r" && memory.constraints.length) return finish("remove");
      if (matchesKey(data, "up")) offset--;
      else if (matchesKey(data, "down")) offset++;
      else if (matchesKey(data, "pageUp")) offset -= pageSize;
      else if (matchesKey(data, "pageDown")) offset += pageSize;
      else if (matchesKey(data, "home")) offset = 0;
      else if (matchesKey(data, "end")) offset = maxOffset;
      offset = Math.max(0, Math.min(offset, maxOffset));
      tui.requestRender();
    },
    invalidate() {},
  };
}

export async function showCheckpoint(ctx: ExtensionContext, memory: WorkMemory, goal: string): Promise<CheckpointAction> {
  return ctx.ui.custom<CheckpointAction>((tui, theme, _keys, done) => createCheckpointComponent({ memory, goal, theme, tui, done }), {
    overlay: true, overlayOptions: { width: 110, maxHeight: "100%", anchor: "center", margin: 2 },
  });
}
