import { getMarkdownTheme, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, Markdown, ScrollView, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { clearRenderCache, renderChange } from "./diff-view.ts";
import type { ChangePreview } from "./review-model.ts";
import type { BridgeDecision } from "./bridge.ts";

export type PermissionDecision = BridgeDecision;
export interface ReviewOptions {
  title: string;
  why: string;
  changes: ChangePreview[];
  theme: Theme;
  tui: TUI;
  done: (decision: PermissionDecision) => void;
  readOnly?: boolean;
  onOpenExternal?: (selected: number) => Promise<void>;
}
type Mode = "review" | "note" | "search" | "why" | "help";
type Hit = { x: number; y: number; width: number; action: () => void };

// Model-authored strings never get to supply terminal control sequences.
function plain(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function pad(value: string, width: number): string {
  const text = truncateToWidth(value, width);
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** The production review component is also the deterministic fixture surface. */
export class ReviewComponent implements Component, Focusable {
  focused = true;
  private selected = 0;
  private mode: Mode = "review";
  private layout: "auto" | "unified" | "split" = "auto";
  private wrap = true;
  private sidebar = false;
  private query = "";
  private notice = "";
  private externalBusy = false;
  private closed = false;
  private canApprove = false;
  private height = 1;
  private bodyY = 0;
  private bodyX = 2;
  private bodyWidth = 1;
  private editorY = -1;
  private editorHeight = 0;
  private searchY = -1;
  private hits: Hit[] = [];
  private rendered = { lines: [] as string[], hunks: [] as number[], matches: [] as number[], layout: "unified" as "unified" | "split" };
  private auxiliary = new ScrollView({ render: () => [], invalidate() {} });
  private readonly scrolls: ScrollView[];
  private readonly noteEditor: Editor;
  private readonly searchInput: Input;
  private readonly why: Markdown;
  private readonly sectionWhy: Markdown[];
  private readonly options: ReviewOptions;

  constructor(options: ReviewOptions) {
    this.options = options;
    if (!options.changes.length) throw new Error("A review needs at least one action.");
    this.scrolls = options.changes.map(() => new ScrollView({ render: () => [], invalidate() {} }));
    this.why = new Markdown(plain(options.why), 0, 0, getMarkdownTheme());
    this.sectionWhy = options.changes.map(change => new Markdown(plain([
      change.why, ...(change.annotations ?? []).map(section => `### ${section.title} · lines ${section.startLine}–${section.endLine}\n${section.why}`),
    ].filter(Boolean).join("\n\n")), 0, 0, getMarkdownTheme()));
    // The native editor supplies paste, selection, Unicode, undo and cursor behavior.
    // Its virtual height limits note growth so the reviewed code stays on screen.
    const editorTui = Object.create(options.tui) as TUI;
    const editorTerminal = Object.create(options.tui.terminal);
    Object.defineProperty(editorTerminal, "rows", { get: () => 17 });
    // ctx.ui.custom supplies a forwarding Proxy. Assignment on a derived object
    // can invoke that Proxy's inherited set trap and replace the real terminal.
    Object.defineProperty(editorTui, "terminal", { value: editorTerminal });
    this.noteEditor = new Editor(editorTui, { borderColor: (s) => options.theme.fg("borderMuted", s), selectList: getSelectListTheme() }, { paddingX: 0 });
    this.noteEditor.onSubmit = (note) => {
      const trimmed = note.trim();
      if (trimmed) this.finish({ action: "deny", note: trimmed });
      else this.notice = "Enter a note, or press Esc to return to the review.";
    };
    this.searchInput = new Input({ prompt: "/ ", placeholder: "Find in this file", placeholderStyle: (s) => options.theme.fg("dim", s) });
    this.searchInput.onSubmit = () => { this.query = this.searchInput.getValue(); this.mode = "review"; this.scrolls[this.selected].scrollToStart(); };
    this.searchInput.onEscape = () => { this.mode = "review"; this.query = ""; this.searchInput.setValue(""); };
  }

  get state() {
    return { selected: this.selected, mode: this.mode, offset: this.scrolls[this.selected].scrollTop, query: this.query, layout: this.layout, wrap: this.wrap, canApprove: this.canApprove, externalBusy: this.externalBusy };
  }
  private redraw() { if (!this.closed) this.options.tui.requestRender(); }
  private finish(decision: PermissionDecision) {
    if (this.closed) return;
    this.closed = true;
    this.options.done(decision);
  }
  private select(index: number) {
    this.selected = (index + this.options.changes.length) % this.options.changes.length;
    this.notice = "";
    this.redraw();
  }
  private activeScroll() { return this.mode === "why" || this.mode === "help" ? this.auxiliary : this.scrolls[this.selected]; }
  private jump(rows: number[], direction: number) {
    if (!rows.length) return;
    const scroll = this.activeScroll();
    const current = scroll.scrollTop;
    const target = direction > 0 ? rows.find((row) => row > current) ?? rows[0] : [...rows].reverse().find((row) => row < current) ?? rows[rows.length - 1];
    scroll.scrollTo(target);
  }
  private async openExternal() {
    if (this.externalBusy || !this.options.onOpenExternal || this.options.changes[this.selected].kind === "Result") return;
    this.externalBusy = true;
    this.notice = "Opening this action in VS Code…";
    this.redraw();
    try {
      await this.options.onOpenExternal(this.selected);
      this.notice = "Action opened in VS Code. Return here to decide.";
    } catch (error) {
      this.notice = "Could not open VS Code: " + plain(error instanceof Error ? error.message : String(error));
    } finally { this.externalBusy = false; this.redraw(); }
  }
  private addButtons(lines: string[], buttons: { label: string; action: () => void }[], width: number, color: "accent" | "muted" = "accent") {
    let row = "";
    let x = 0;
    let hitRow = lines.length + 1;
    for (const button of buttons) {
      const label = truncateToWidth(button.label, width);
      const length = visibleWidth(label);
      if (x && x + length > width) {
        lines.push(this.options.theme.fg(color, row.trimEnd()));
        row = ""; x = 0; hitRow = lines.length + 1;
      }
      this.hits.push({ x: x + 2, y: hitRow, width: length, action: button.action });
      row += label + "  "; x += length + 2;
    }
    if (row) lines.push(this.options.theme.fg(color, row.trimEnd()));
  }

  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const { theme, changes } = this.options;
    const inner = Math.max(1, width - 4);
    const available = Math.max(1, this.options.tui.terminal.rows - 4);
    const change = changes[this.selected];
    const file = change.diff !== undefined;
    const resultOnly = this.options.readOnly && change.kind === "Result";
    this.hits = []; this.editorY = -1; this.editorHeight = 0; this.searchY = -1;
    this.canApprove = false;
    if (width < 45 || available < 15) {
      return [theme.fg("accent", "Pair review · resize to continue"), truncateToWidth(plain(this.options.title), width), "Use a larger terminal to inspect the step.", this.options.readOnly ? "Esc Close" : "d / Esc Deny"].slice(0, available).map((line) => truncateToWidth(line, width));
    }
    const totalAdded = changes.reduce((sum, item) => sum + item.added, 0);
    const totalRemoved = changes.reduce((sum, item) => sum + item.removed, 0);
    const files = changes.filter(item => item.diff !== undefined).length;
    const commands = changes.filter(item => item.command !== undefined).length;
    const mixed = files > 0 && commands > 0;
    const scope = mixed ? `${changes.length} actions · ${files} ${files === 1 ? "file" : "files"} · ${commands} ${commands === 1 ? "command" : "commands"}`
      : files ? `${files} ${files === 1 ? "file" : "files"} · +${totalAdded} −${totalRemoved}` : resultOnly ? "Saved result" : commands > 1 ? `${commands} commands` : "Command";
    const lines: string[] = [theme.fg("accent", `${this.options.readOnly ? "Review" : "Review step"} · ${scope}`), ...wrapTextWithAnsi(theme.bold(plain(this.options.title)), inner)];
    const section = change.why || change.annotations?.length ? this.sectionWhy[this.selected].render(inner) : [];
    const stepWhy = this.why.render(inner);
    const whyLines = section.length ? [...section, "", theme.fg("muted", "Step purpose"), ...stepWhy] : stepWhy;
    if (this.mode !== "why" && this.mode !== "help") {
      if (this.mode !== "note") lines.push("");
      const whyLimit = this.mode === "note" ? 1 : 2;
      const short = whyLines.slice(0, whyLimit);
      if (whyLines.length > whyLimit) short[short.length - 1] = truncateToWidth(short[short.length - 1], Math.max(1, inner - 14)) + theme.fg("muted", this.mode === "note" ? "  …" : "  [i] More why");
      lines.push(...short);
    }
    if (this.mode !== "note") lines.push("");
    if (changes.length > 1 && this.mode !== "note") {
      const tabWidth = Math.floor((inner - (changes.length - 1) * 2) / changes.length);
      this.addButtons(lines, changes.map((item, i) => ({ label: (i === this.selected ? "▸ " : "  ") + truncateToWidth(`${i + 1} ${plain(item.command !== undefined ? item.kind : item.label)}`, Math.max(4, tabWidth - 2)), action: () => this.select(i) })), inner);
    }
    if (file) lines.push(...wrapTextWithAnsi(theme.bold(`${this.selected + 1}/${changes.length} · ${plain(change.label)}`) + theme.fg("muted", `  ${plain(change.kind)} · +${change.added} −${change.removed}${change.status ? ` · ${plain(change.status)}` : ""}`), inner));
    else lines.push(theme.fg("muted", `${changes.length > 1 ? `Action ${this.selected + 1}/${changes.length} · ` : ""}${plain(change.kind)}${change.status ? ` · ${plain(change.status)}` : ""}`));
    lines.push(theme.fg("borderMuted", "─".repeat(inner)));

    const footer: string[] = [];
    // Position is filled after rendering; reserve its one row here.
    footer.push("");
    if (this.notice) footer.push(...wrapTextWithAnsi(theme.fg("warning", this.notice), inner));
    let input: string[] = [];
    this.noteEditor.focused = this.focused && this.mode === "note";
    this.searchInput.focused = this.focused && this.mode === "search";
    if (this.mode === "note") {
      input = [theme.fg("accent", "Deny with note · What should change?"), ...this.noteEditor.render(inner)];
      footer.push(theme.fg("accent", "Enter Send denial · Shift+Enter New line · Esc Back"));
    } else if (this.mode === "search") {
      input = this.searchInput.render(inner);
      footer.push(theme.fg("accent", "Enter Keep search · Esc Clear and return"));
    } else if (this.mode === "why" || this.mode === "help") {
      footer.push(theme.fg("accent", "Esc / Enter Back to review"));
      footer.push(theme.fg("muted", "↑/↓ Scroll · PgUp/PgDn Page"));
    } else {
      // Button hit regions are placed below after the viewport height is known.
      footer.push(...wrapTextWithAnsi(theme.fg("accent", this.options.readOnly ? "[q] Close" : `[a] Approve step · ${changes.length > 1 ? `all ${changes.length} actions` : file ? "1 file" : "command"}   [d] Deny   [n] Deny with note`), inner));
      footer.push(...wrapTextWithAnsi(theme.fg("muted", file ? `${changes.length > 1 ? "Tab Actions · " : ""}[ / ] Changes · / Search${this.options.onOpenExternal ? " · v VS Code" : ""} · ? Help` : `${changes.length > 1 ? "Tab Actions · " : ""}↑/↓ Scroll · i Why${this.options.onOpenExternal && !resultOnly ? " · v VS Code" : ""} · Esc ${this.options.readOnly ? "Close" : "Deny"}`), inner));
    }
    const room = available - lines.length - footer.length - input.length - 2;
    if (room < 2) {
      this.hits = [];
      return [theme.fg("accent", "Pair review · resize to continue"), truncateToWidth(plain(this.options.title), width), "Enlarge the terminal to show all review controls.", this.options.readOnly ? "Esc Close" : "d / Esc Deny"].slice(0, available).map((line) => truncateToWidth(line, width));
    }
    const sideWidth = this.sidebar && changes.length > 1 && inner >= 116 && this.mode !== "why" && this.mode !== "help" ? Math.min(30, Math.floor(inner * 0.23)) : 0;
    const contentWidth = inner - (sideWidth ? sideWidth + 3 : 0) - 1;
    const rendered = renderChange(change, theme, contentWidth, { layout: this.layout, wrap: this.wrap, query: this.query });
    this.rendered = rendered;
    let body = rendered.lines;
    if (this.mode === "why") body = [theme.fg("accent", "Why this action"), "", ...whyLines];
    if (this.mode === "help") body = this.help().flatMap((line) => wrapTextWithAnsi(line, contentWidth));
    const scroll = this.activeScroll();
    this.height = Math.max(2, Math.min(body.length || 1, room));
    scroll.updateLayout(body.length, this.height, () => this.redraw());
    const offset = scroll.scrollTop;
    this.bodyY = lines.length + 1;
    this.bodyX = 2 + (sideWidth ? sideWidth + 3 : 0);
    this.bodyWidth = contentWidth;
    const pane = body.slice(offset, offset + this.height);
    while (pane.length < this.height) pane.push("");
    const max = Math.max(1, body.length - this.height);
    const thumb = Math.round((offset / max) * (this.height - 1));
    for (let row = 0; row < pane.length; row++) {
      let renderedRow = pad(pane[row], contentWidth) + (body.length > this.height ? theme.fg(row === thumb ? "accent" : "borderMuted", row === thumb ? "┃" : "│") : " ");
      if (sideWidth) {
        const item = changes[row];
        const label = item ? theme.fg(row === this.selected ? "accent" : "muted", truncateToWidth(`${row === this.selected ? "▸" : " "} ${row + 1} ${plain(item.label)}`, sideWidth)) : "";
        if (item) this.hits.push({ x: 2, y: this.bodyY + row, width: sideWidth, action: () => this.select(row) });
        renderedRow = pad(label, sideWidth) + theme.fg("borderMuted", " │ ") + renderedRow;
      }
      lines.push(renderedRow);
    }
    const hunkIndex = Math.max(0, rendered.hunks.filter((row) => row <= offset).length - 1);
    const position = `${changes.length > 1 ? `Action ${this.selected + 1}/${changes.length}` : file ? "File 1/1" : resultOnly ? "Result" : "Command"}${file && rendered.hunks.length ? ` · Change ${hunkIndex + 1}/${rendered.hunks.length}` : ""} · Lines ${body.length ? offset + 1 : 0}–${Math.min(body.length, offset + this.height)} of ${body.length}${this.query ? ` · ${rendered.matches.length} matches · f/F Next/previous` : ""}`;
    footer[0] = theme.fg("dim", truncateToWidth(position, inner));
    if (input.length) {
      if (this.mode === "note") { this.editorY = lines.length + 2; this.editorHeight = input.length - 1; }
      else this.searchY = lines.length + 1;
      lines.push(...input);
    }
    const footerY = lines.length + 1;
    lines.push(...footer);
    this.canApprove = !this.options.readOnly && this.mode === "review" && !this.externalBusy;
    if (this.mode === "review") {
      for (const [actionLine, actionText] of footer.entries()) {
        const text = plain(actionText);
        for (const [key, action] of this.options.readOnly ? [["[q]", () => this.finish({ action: "deny" })] as const] : [
          ["[a]", () => { if (this.canApprove) this.finish({ action: "approve" }); }] as const,
          ["[d]", () => this.finish({ action: "deny" })] as const,
          ["[n]", () => { this.mode = "note"; this.notice = ""; this.redraw(); }] as const,
        ]) {
          const start = text.indexOf(key);
          if (start >= 0) this.hits.push({ x: start + 2, y: footerY + actionLine, width: (text.slice(start + key.length).search(/\s+\[/) + key.length) > key.length ? text.slice(start + key.length).search(/\s+\[/) + key.length : text.length - start, action });
        }
      }
    }
    const border = (s: string) => theme.fg("borderAccent", s);
    return [border("╭" + "─".repeat(width - 2) + "╮"), ...lines.map((line) => border("│") + " " + pad(line, inner) + " " + border("│")), border("╰" + "─".repeat(width - 2) + "╯")];
  }

  private help(): string[] {
    return ["Review controls", "", "Tab / Shift+Tab   Next / previous action", "1–8               Select an action", "[ / ]             Previous / next changed section", "↑ / ↓             Scroll one line", "PgUp / PgDn       Scroll one page", "Home / End        Beginning / end", "/                 Search this file", "f / F             Next / previous search match", "w                 Toggle line wrapping", "s                 Toggle unified / side-by-side diff", "t                 Toggle action sidebar on wide terminals", "i                 Full explanation", ...(this.options.onOpenExternal ? ["v                 Open selected action in VS Code"] : []), "", this.options.readOnly ? "q / Esc           Close review" : "a Approve · d / Esc Deny · n Deny with note", "", "Mouse: click action tabs or action labels; wheel scrolls code."];
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (this.mode === "note") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.mode = "review"; this.notice = ""; }
      else this.noteEditor.handleInput(data);
      this.redraw(); return;
    }
    if (this.mode === "search") {
      this.searchInput.handleInput(data);
      this.query = this.searchInput.getValue();
      this.redraw(); return;
    }
    if ((this.mode === "why" || this.mode === "help") && (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c"))) {
      this.mode = "review"; this.redraw(); return;
    }
    if (this.mode === "review") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || (this.options.readOnly && data === "q")) return this.finish({ action: "deny" });
      if (!this.options.readOnly && data === "d") return this.finish({ action: "deny" });
      if (!this.options.readOnly && data === "a" && this.canApprove) return this.finish({ action: "approve" });
      if (!this.options.readOnly && data === "n" && this.canApprove) { this.mode = "note"; this.notice = ""; }
      else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.select(this.selected + 1);
      else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.select(this.selected - 1);
      else if (/^[1-8]$/.test(data) && Number(data) <= this.options.changes.length) this.select(Number(data) - 1);
      else if (data === "[") this.jump(this.rendered.hunks, -1);
      else if (data === "]") this.jump(this.rendered.hunks, 1);
      else if (data === "f") this.jump(this.rendered.matches, 1);
      else if (data === "F") this.jump(this.rendered.matches, -1);
      else if (data === "/") this.mode = "search";
      else if (data === "w") this.wrap = !this.wrap;
      else if (data === "s") this.layout = this.rendered.layout === "split" ? "unified" : "split";
      else if (data === "t") this.sidebar = !this.sidebar;
      else if (data === "i" || data === "?") { this.mode = data === "i" ? "why" : "help"; this.auxiliary.scrollToStart(); }
      else if (data === "v") void this.openExternal();
    }
    const scroll = this.activeScroll();
    if (matchesKey(data, "up")) scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) scroll.scrollBy(-this.height);
    else if (matchesKey(data, "pageDown")) scroll.scrollBy(this.height);
    else if (matchesKey(data, "home")) scroll.scrollToStart();
    else if (matchesKey(data, "end")) scroll.scrollToEnd();
    this.redraw();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return { handled: true };
    if (this.mode === "note" && this.editorY >= 0 && event.y >= this.editorY && event.y < this.editorY + this.editorHeight) {
      return this.noteEditor.handleMouse({ ...event, x: event.x - 2, y: event.y - this.editorY, width: event.width - 4 }) ?? { handled: true, focus: true, render: false };
    }
    if (event.type === "wheel") { this.activeScroll().scrollBy(event.wheelDelta ?? 0); this.redraw(); return { handled: true, focus: true }; }
    if (this.mode === "search" && event.y === this.searchY) {
      return this.searchInput.handleMouse({ ...event, x: event.x - 2, y: 0, width: event.width - 4 });
    }
    if (event.type === "click" && event.button === "left" && this.mode === "review") {
      const hit = this.hits.find((entry) => entry.y === event.y && event.x >= entry.x && event.x < entry.x + entry.width);
      if (hit) { hit.action(); this.redraw(); return { handled: true, focus: true }; }
      if (event.x === this.bodyX + this.bodyWidth && event.y >= this.bodyY && event.y < this.bodyY + this.height) {
        const row = (event.y - this.bodyY) / Math.max(1, this.height - 1);
        this.activeScroll().scrollTo(row * Math.max(0, this.rendered.lines.length - this.height));
        this.redraw(); return { handled: true, focus: true };
      }
    }
    return { handled: true, focus: true, render: false };
  }
  invalidate() { clearRenderCache(); this.why.invalidate(); this.noteEditor.invalidate(); this.searchInput.invalidate(); }
  dispose() { this.closed = true; }
}

export function createReviewComponent(options: ReviewOptions): ReviewComponent { return new ReviewComponent(options); }
