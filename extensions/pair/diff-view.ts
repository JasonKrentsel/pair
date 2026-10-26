import { getLanguageFromPath, highlightCode, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, rgbColor, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { diffWordsWithSpace } from "diff";
import { displaySource, normalizeSource, reviewHunks, type ChangePreview, type ReviewLine } from "./review-model.ts";

export interface RenderOptions { layout?: "auto" | "unified" | "split"; wrap?: boolean; query?: string }
export interface RenderedChange { lines: string[]; hunks: number[]; layout: "unified" | "split"; matches: number[] }
type Span = { start: number; end: number };
const sourceCache = new Map<string, string[]>();
const modelCache = new WeakMap<ChangePreview, { before: string; after: string; hunks: ReturnType<typeof reviewHunks> }>();
const layoutCache = new WeakMap<ChangePreview, { key: string; signature: string; theme: Theme; result: RenderedChange }>();
const MAX_CACHE = 24;
let generation = 0;
export function clearRenderCache(): void { sourceCache.clear(); generation++; }

/** Each source line must be independently styled: a multiline comment can span a terminal reset. */
export function independentHighlightLines(lines: string[]): string[] {
  const state = new Map<string, string>();
  return lines.map((line) => {
    const prefix = [...state.values()].join("");
    for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
      const codes = (match[1] || "0").split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) state.clear();
        else if (code === 38 || code === 48) {
          const length = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
          state.set(code === 38 ? "fg" : "bg", `\x1b[${codes.slice(i, i + length).join(";")}m`);
          i += length - 1;
        } else if (code === 39) state.delete("fg");
        else if (code === 49) state.delete("bg");
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set("fg", `\x1b[${code}m`);
        else if (code === 1 || code === 2 || code === 3 || code === 4) state.set(String(code), `\x1b[${code}m`);
        else if (code === 22) { state.delete("1"); state.delete("2"); }
        else if (code === 23) state.delete("3");
        else if (code === 24) state.delete("4");
      }
    }
    return prefix + line + "\x1b[0m";
  });
}

function highlighted(source: string, label: string, theme: Theme): string[] {
  const clean = displaySource(normalizeSource(source));
  const language = getLanguageFromPath(label);
  const key = generation + "\0" + (theme.name ?? theme.appearance) + "\0" + language + "\0" + clean;
  const existing = sourceCache.get(key);
  if (existing) return existing;
  // Very large files retain all review text without making highlighting block interaction.
  const lines = clean.length > 100_000 ? clean.split("\n") : independentHighlightLines(highlightCode(clean, language));
  sourceCache.set(key, lines);
  if (sourceCache.size > MAX_CACHE) sourceCache.delete(sourceCache.keys().next().value!);
  return lines;
}

function spans(oldText: string, newText: string): [Span[], Span[]] {
  const oldSpans: Span[] = [], newSpans: Span[] = [];
  if (oldText.length + newText.length > 4000) return [oldSpans, newSpans];
  let oldOffset = 0, newOffset = 0;
  for (const part of diffWordsWithSpace(oldText, newText)) {
    if (part.removed) { oldSpans.push({ start: oldOffset, end: oldOffset + part.value.length }); oldOffset += part.value.length; }
    else if (part.added) { newSpans.push({ start: newOffset, end: newOffset + part.value.length }); newOffset += part.value.length; }
    else { oldOffset += part.value.length; newOffset += part.value.length; }
  }
  return [oldSpans, newSpans];
}

function querySpans(text: string, query?: string): Span[] {
  if (!query) return [];
  const lower = text.toLocaleLowerCase(), search = query.toLocaleLowerCase();
  const result: Span[] = [];
  for (let index = lower.indexOf(search); index >= 0; index = lower.indexOf(search, index + search.length)) result.push({ start: index, end: index + search.length });
  return result;
}

function paint(code: string, ranges: Span[], searches: Span[], base: string, emphasis: string, match: string): string {
  let index = 0, output = "", active = "";
  const background = () => searches.some((s) => index >= s.start && index < s.end) ? match
    : ranges.some((s) => index >= s.start && index < s.end) ? emphasis : base;
  for (const part of code.match(/\x1b\[[\d;]*m|[^\x1b]+|\x1b/g) ?? []) {
    if (part.startsWith("\x1b")) {
      output += part;
      if (/\x1b\[(?:0|49)?m/.test(part)) { active = ""; output += background(); active = background(); }
      continue;
    }
    for (const character of part) {
      const next = background();
      if (next !== active) { output += next; active = next; }
      output += character;
      index += character.length;
    }
  }
  return output + "\x1b[49m";
}

function fill(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderChange(change: ChangePreview, theme: Theme, availableWidth: number, options: RenderOptions = {}): RenderedChange {
  const width = Math.max(1, Math.floor(availableWidth));
  const wrap = options.wrap !== false;
  const cacheKey = `${generation}:${width}:${options.layout ?? "auto"}:${wrap}:${options.query ?? ""}`;
  const signature = JSON.stringify([change.label, change.kind, change.before, change.after, change.diff, change.text, change.command, change.cwd, change.added, change.removed]);
  const cachedLayout = layoutCache.get(change);
  if (cachedLayout?.key === cacheKey && cachedLayout.signature === signature && cachedLayout.theme === theme) return cachedLayout.result;
  const lines: string[] = [], hunks: number[] = [], matches: number[] = [];
  const searchColor = theme.getBgAnsi("searchMatchBg");
  const append = (text: string) => { lines.push(truncateToWidth(text, width)); };
  const wrapped = (text: string, budget = width) => wrap ? wrapTextWithAnsi(text, Math.max(1, budget)) : [truncateToWidth(text, Math.max(1, budget))];
  const result = (layout: "unified" | "split" = "unified"): RenderedChange => {
    for (let i = 0; options.query && i < lines.length; i++) {
      // Wrapping can combine foreground and background SGRs into one escape sequence.
      const hasSearchColor = [...lines[i].matchAll(/\x1b\[([\d;]*)m/g)].some((match) => (";" + match[1] + ";").includes(";" + searchColor.slice(2, -1) + ";"));
      if (options.query && (hasSearchColor || stripTerminalSequences(lines[i]).toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) matches.push(i);
    }
    const rendered = { lines, hunks, layout, matches };
    layoutCache.set(change, { key: cacheKey, signature, theme, result: rendered });
    return rendered;
  };
  if (change.diff === undefined && change.before === undefined) {
    if (change.cwd) wrapped(theme.fg("muted", "In " + displaySource(change.cwd))).forEach(append);
    const command = change.command ?? change.text ?? change.label;
    const cleanCommand = displaySource(command);
    const code = change.kind === "Result" ? cleanCommand.split("\n") : independentHighlightLines(highlightCode(cleanCommand, change.kind === "powershell" ? "powershell" : "bash"));
    code.flatMap((line, index) => wrapped(paint(line, [], querySpans(cleanCommand.split("\n")[index] ?? "", options.query), "\x1b[49m", "\x1b[49m", searchColor))).forEach(append);
    if (change.command && change.text && change.text !== command) wrapped(displaySource(change.text)).forEach(append);
    return result();
  }
  if (change.before === undefined || change.after === undefined) {
    // Existing sessions hold Pi's display diff, not the source snapshots.
    renderDiff(displaySource(stripTerminalSequences(change.diff ?? ""))).split("\n").flatMap((line) => wrapped(line)).forEach(append);
    if (change.text) wrapped(displaySource(change.text)).forEach(append);
    return result();
  }
  const cached = modelCache.get(change);
  const sections = cached?.before === change.before && cached.after === change.after ? cached.hunks : reviewHunks(change.before, change.after);
  if (!cached || cached.hunks !== sections) modelCache.set(change, { before: change.before, after: change.after, hunks: sections });
  const oldLines = highlighted(change.before, change.label, theme);
  const newLines = highlighted(change.after, change.label, theme);
  const digits = Math.max(2, String(Math.max(oldLines.length, newLines.length)).length);
  const longest = sections.reduce((max, hunk) => hunk.lines.reduce((value, line) => Math.max(value, visibleWidth(line.text)), max), 0);
  const splitWidth = Math.floor((width - 3) / 2);
  // Pure additions/deletions waste half the screen; use a single source column for them.
  const balanced = change.added > 0 && change.removed > 0 && Math.max(change.added, change.removed) <= Math.min(change.added, change.removed) * 4;
  const split = options.layout !== "unified" && width >= 110 && balanced && (options.layout === "split" || longest <= (splitWidth - digits - 3) * 1.25);
  const layout = split ? "split" : "unified";
  // Review overlays sit on the terminal background, not inside a full tool-result
  // background. Soften the host's tool fill before adding change tints.
  const neutral = theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
  const baseColor = mixColors(theme.colors.toolPendingBg, neutral, 0.65);
  const color = (kind: ReviewLine["kind"], strong = false) => kind === "add" || kind === "remove"
    ? backgroundAnsi(mixColors(baseColor, theme.colors[kind === "add" ? "success" : "error"], strong ? 0.35 : 0.12), theme.getColorMode()) : "\x1b[49m";
  const emphasize = new Map<ReviewLine, Span[]>();
  for (const section of sections) {
    for (let i = 0; i < section.lines.length;) {
      if (section.lines[i].kind !== "remove") { i++; continue; }
      const removed: ReviewLine[] = [], added: ReviewLine[] = [];
      while (section.lines[i]?.kind === "remove") removed.push(section.lines[i++]);
      while (section.lines[i]?.kind === "add") added.push(section.lines[i++]);
      for (let j = 0; j < Math.min(removed.length, added.length); j++) {
        const [oldRanges, newRanges] = spans(removed[j].text, added[j].text);
        emphasize.set(removed[j], oldRanges); emphasize.set(added[j], newRanges);
      }
    }
  }
  const renderLine = (line: ReviewLine | undefined, budget: number, side?: "old" | "new"): string[] => {
    if (!line) return [" ".repeat(budget)];
    if (line.kind === "meta") return wrapped(theme.fg("dim", line.text), budget).map((row) => fill(row, budget));
    const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
    const oldNumber = line.oldLine === undefined ? "" : String(line.oldLine);
    const newNumber = line.newLine === undefined ? "" : String(line.newLine);
    const gutterText = side ? `${(side === "old" ? oldNumber : newNumber).padStart(digits)} ${sign} `
      : `${oldNumber.padStart(digits)} ${newNumber.padStart(digits)} ${sign} `;
    const gutter = theme.fg(line.kind === "add" ? "success" : line.kind === "remove" ? "error" : "dim", gutterText);
    const codeWidth = Math.max(1, budget - visibleWidth(gutterText));
    const code = line.kind === "remove" ? oldLines[(line.oldLine ?? 1) - 1] : newLines[(line.newLine ?? 1) - 1];
    const styled = paint(code ?? line.text, emphasize.get(line) ?? [], querySpans(line.text, options.query), color(line.kind), color(line.kind, true), searchColor);
    return wrapped(styled, codeWidth).map((row, i) => {
      const prefix = i === 0 ? gutter : theme.fg("dim", " ".repeat(Math.max(0, gutterText.length - 2)) + "↳ ");
      const rowBackground = color(line.kind);
      return rowBackground + fill(prefix + row, budget).replace(/\x1b\[49m/g, rowBackground) + "\x1b[49m";
    });
  };
  if (split) append(theme.fg("muted", fill("Before", splitWidth) + " │ Proposed"));
  for (let h = 0; h < sections.length; h++) {
    const section = sections[h];
    if (h > 0) append(theme.fg("dim", "⋯ unchanged lines"));
    hunks.push(lines.length);
    append(theme.fg("muted", `Change ${h + 1}/${sections.length} · −${section.oldStart},${section.oldCount} +${section.newStart},${section.newCount}`));
    if (!split) { for (const line of section.lines) renderLine(line, width).forEach(append); continue; }
    for (let i = 0; i < section.lines.length;) {
      const current = section.lines[i];
      let left: (ReviewLine | undefined)[] = [], right: (ReviewLine | undefined)[] = [];
      if (current.kind === "context" || current.kind === "meta") { left = [current]; right = [current]; i++; }
      else {
        while (section.lines[i]?.kind === "remove") left.push(section.lines[i++]);
        while (section.lines[i]?.kind === "add") right.push(section.lines[i++]);
      }
      for (let r = 0; r < Math.max(left.length, right.length); r++) {
        const beforeRows = renderLine(left[r], splitWidth, "old"), afterRows = renderLine(right[r], width - splitWidth - 3, "new");
        for (let row = 0; row < Math.max(beforeRows.length, afterRows.length); row++) append(fill(beforeRows[row] ?? "", splitWidth) + theme.fg("borderMuted", " │ ") + (afterRows[row] ?? ""));
      }
    }
  }
  if (!sections.length) append(theme.fg("muted", change.text ? "No text changes; file format changes below." : "No text changes."));
  if (change.text) wrapped(theme.fg("warning", displaySource(change.text))).forEach(append);
  return result(layout);
}
