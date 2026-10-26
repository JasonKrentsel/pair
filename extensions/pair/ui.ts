import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type OverlayHandle } from "@earendil-works/pi-tui";
import type { PairState } from "./state.ts";
import { createReviewComponent, type PermissionDecision } from "./review.ts";
import type { ChangePreview } from "./review-model.ts";
export type { ChangePreview } from "./review-model.ts";
export type { PermissionDecision } from "./review.ts";

export type PanelAction = "close" | "discuss" | "revise" | "approve" | "finish" | "resume";
export type PanelView = "design" | "increment" | "review";
export interface PanelResult { action: PanelAction; view: PanelView }

// Never pass model-authored terminal controls through to the terminal.
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function code(text: string, language = ""): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const fence = "`".repeat(longest + 1);
  return fence + language + "\n" + text + "\n" + fence;
}

export function incrementOverview(state: PairState): string {
  const inc = state.increment;
  if (!inc) return "No saved increment. Ask for work in chat; the next meaningful change will request permission in place.";
  const operations = inc.operations?.map((op) => "- " + (op.kind === "move" ? "Move " : "Copy ") + op.from + " → " + op.to + (op.completed ? " (completed)" : "")).join("\n");
  return [
    "# " + inc.title, "Saved increment r" + inc.revision + ". Reference only; new changes request permission individually.",
    "## What changes", inc.behavior, "## How it works", inc.approach,
    "## Verification", inc.verification, "## Scope",
    inc.files.length + " concrete files · " + inc.commands.length + " shell commands. Open Files and Commands for exact scope.",
    operations ?? "", state.pauseReason ? "## Saved review note\n\n" + state.pauseReason : "",
  ].filter(Boolean).join("\n\n");
}

function designSections(text: string): { name: string; text: string }[] {
  const sections = [{ name: "Full design", text: text || "# Pair is ready\n\nAsk for work in chat. Each meaningful change shows its explanation and exact edit with Approve, Deny, or Deny with note.\n\nA design document is optional. Routine local Git setup and inspection remain available without this panel." }];
  const lines = text.split("\n");
  const headings: { line: number; name: string }[] = [];
  let fence: string | undefined;
  const fencePattern = /^\s{0,3}(`{3,}|~{3,})/;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(fencePattern);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    const heading = !fence && lines[i].match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ line: i, name: heading[1] });
  }
  for (let i = 0; i < headings.length; i++) {
    sections.push({ name: headings[i].name, text: lines.slice(headings[i].line, headings[i + 1]?.line).join("\n") });
  }
  return sections;
}

export function updateWidget(ctx: ExtensionContext, state?: PairState): void {
  if (!ctx.hasUI) return;
  if (!state?.active) {
    ctx.ui.setWidget("pair", undefined);
    ctx.ui.setStatus("pair", undefined);
    return;
  }
  ctx.ui.setStatus("pair", "Pair on");
  ctx.ui.setWidget("pair", undefined);
}

export async function showPanel(ctx: ExtensionContext, state: PairState, diff: string, confirmApproval = false, readOnly = false): Promise<PanelResult> {
  const inc = state.increment;
  const views = [
    { id: "design" as const, name: "Design", sections: designSections(state.design.text) },
    { id: "increment" as const, name: "Saved scope", sections: [
      { name: "Overview", text: incrementOverview(state) },
      { name: "Files", text: inc ? "# File scope\n\n" + inc.files.length + " exact paths; directories were expanded when proposed.\n\n" + code(inc.files.join("\n")) : "No files proposed." },
      { name: "Commands", text: inc?.commands.length ? "# Exact shell commands\n\n" + inc.commands.map((entry, i) => "## " + (i + 1) + ". " + entry.tool + "\n\n" + code(entry.command, entry.tool)).join("\n\n") : "No shell commands requested." },
    ] },
    { id: "review" as const, name: "Review", sections: [
      { name: "Summary", text: ["# Increment review", inc?.summary ?? "No completion report yet.", "## Verification reported by the agent", inc?.checks ?? "Not reported.", "## Deviations", inc?.deviations ?? "Not reported.", "## Working changes", "Open the Diff section to compare against the approval baseline."].join("\n\n") },
      { name: "Diff", text: "# Changes since approval\n\n" + code(diff, "diff") },
    ] },
  ];
  return ctx.ui.custom<PanelResult>((tui, theme, _keybindings, done) => {
    let tab = state.phase === "review" ? 2 : state.phase.startsWith("design") || !inc ? 0 : 1;
    const section = [0, 0, 0];
    const offsets = new Map<string, number>();
    const documents = new Map<string, Markdown>();
    let confirming = confirmApproval;
    let height = 1;
    let maxOffset = 0;
    const key = () => tab + ":" + section[tab];
    const canApprove = () => !readOnly && tab === 0 && state.phase === "design-approval";
    const finish = (action: PanelAction) => done({ action, view: views[tab].id });
    return {
      render(width) {
        const availableWidth = Math.max(1, Math.min(width, 106));
        const padding = availableWidth > 12 ? 2 : 0;
        const bodyWidth = Math.max(1, availableWidth - padding * 2);
        const selected = views[tab].sections[section[tab]];
        let document = documents.get(key());
        if (!document) {
          document = new Markdown(plain(selected.text), 0, 0, getMarkdownTheme());
          documents.set(key(), document);
        }
        const content = document.render(bodyWidth);
        const actions = readOnly ? ["Read-only while work is running"] : ["d Discuss", "r Revise"];
        if (canApprove()) actions.push("a Approve");
        if (!readOnly && tab === 2 && state.phase === "review") actions.push("f Finish review");
        const approval = tab === 0 ? "design r" + state.design.revision : "increment r" + inc?.revision;
        const header = [
          theme.fg("accent", "PAIR · Saved design and review · Changes request permission individually"),
          views.map((view, i) => i === tab ? theme.bold("[" + (i + 1) + " " + view.name + "]") : theme.fg("muted", (i + 1) + " " + view.name)).join("   "),
          theme.fg("muted", (section[tab] + 1) + "/" + views[tab].sections.length + " · " + plain(selected.name) + " · ←/→ Sections"),
          theme.fg("dim", "─".repeat(bodyWidth)),
        ].flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
        const footer = [
          ...(confirming && canApprove() ? [theme.fg("muted", tab === 0 ? "Design approval allows a proposal; implementation needs its own approval."
            : inc!.files.length + " files · " + inc!.commands.length + " shell commands · " + (inc!.operations?.filter((op) => !op.completed).length ?? 0) + " file operations")] : []),
          confirming && canApprove()
            ? theme.fg("warning", "Approve " + approval + "? Enter confirms · Esc cancels")
            : theme.fg("accent", actions.join(" · ")),
          theme.fg("muted", "↑/↓ Scroll · PgUp/PgDn · Home/End · Esc Close"),
        ].flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
        height = Math.max(1, Math.min(40, tui.terminal.rows - header.length - footer.length - 3));
        maxOffset = Math.max(0, content.length - height);
        const offset = Math.min(offsets.get(key()) ?? 0, maxOffset);
        offsets.set(key(), offset);
        const body = content.slice(offset, offset + height);
        while (body.length < height) body.push("");
        const lines = [...header, ...body,
          theme.fg("dim", "Lines " + (content.length ? offset + 1 : 0) + "–" + Math.min(offset + height, content.length) + " of " + content.length),
          ...footer,
        ];
        return lines.map((line) => " ".repeat(padding) + truncateToWidth(line, bodyWidth));
      },
      handleInput(data) {
        if (matchesKey(data, "ctrl+c")) return finish("close");
        if (matchesKey(data, "escape")) {
          if (confirming) confirming = false;
          else return finish("close");
        } else if (confirming && canApprove() && matchesKey(data, "enter")) return finish("approve");
        else if (["1", "2", "3"].includes(data)) { tab = Number(data) - 1; confirming = false; }
        else if (matchesKey(data, "left") || matchesKey(data, "right")) {
          const delta = matchesKey(data, "left") ? -1 : 1;
          section[tab] = (section[tab] + delta + views[tab].sections.length) % views[tab].sections.length;
        } else if (matchesKey(data, "up")) offsets.set(key(), Math.max(0, (offsets.get(key()) ?? 0) - 1));
        else if (matchesKey(data, "down")) offsets.set(key(), Math.min(maxOffset, (offsets.get(key()) ?? 0) + 1));
        else if (matchesKey(data, "pageUp")) offsets.set(key(), Math.max(0, (offsets.get(key()) ?? 0) - height));
        else if (matchesKey(data, "pageDown")) offsets.set(key(), Math.min(maxOffset, (offsets.get(key()) ?? 0) + height));
        else if (matchesKey(data, "home")) offsets.set(key(), 0);
        else if (matchesKey(data, "end")) offsets.set(key(), maxOffset);
        else if (!readOnly && data === "d") return finish("discuss");
        else if (!readOnly && data === "r") return finish("revise");
        else if (data === "a" && canApprove()) confirming = true;
        else if (!readOnly && data === "f" && tab === 2 && state.phase === "review") return finish("finish");
        tui.requestRender();
      },
      invalidate() { documents.clear(); },
    };
  });
}

export interface PermissionViewOptions {
  readOnly?: boolean;
  onOpenExternal?: (selected: number) => Promise<void>;
  onHandle?: (handle: OverlayHandle) => void;
  onClose?: () => void;
}

/** Local UI only: navigating and editing a note never send model messages. */
export async function showPermission(ctx: ExtensionContext, title: string, why: string, changes: ChangePreview[], signal?: AbortSignal, options: PermissionViewOptions = {}): Promise<PermissionDecision> {
  if (signal?.aborted || !changes.length) return { action: "deny" };
  try {
    return await ctx.ui.custom<PermissionDecision>((tui, theme, _keys, done) => {
      let settled = false;
      const finish = (decision: PermissionDecision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        done(decision);
      };
      const abort = () => finish({ action: "deny" });
      const component = createReviewComponent({ title, why, changes, theme, tui, done: finish, readOnly: options.readOnly, onOpenExternal: options.onOpenExternal });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      const dispose = component.dispose.bind(component);
      component.dispose = () => { signal?.removeEventListener("abort", abort); dispose(); };
      return component;
    }, {
      overlay: true,
      // Pi resolves overlayOptions once. Percentage height and native margins
      // follow later terminal resizes; a captured row count would clip our footer.
      // The component uses the same four-row allowance for its fixed controls.
      overlayOptions: { width: 160, maxHeight: "100%", anchor: "center", margin: 2 },
      onHandle: options.onHandle,
    });
  } finally { options.onClose?.(); }
}
