import { getMarkdownTheme, keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { clearRenderCache, renderChange } from "./diff-view.ts";
import type { ChangePreview } from "./review-model.ts";

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const plain = (value: unknown) => stripTerminalSequences(text(value) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export interface StepDetails {
  title: string;
  why: string;
  status: string;
  note?: string;
  changes?: ChangePreview[];
  proposed?: ChangePreview[];
  output?: string;
  stream?: { status: string; text: string; truncated: boolean };
  reviewId?: string;
  revises?: string;
  /** Legacy saved results contain a unified patch rather than display diffs. */
  patch?: string;
}
interface RenderContext { outputPad: number; isError: boolean }

function normalizeChanges(value: unknown): ChangePreview[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = record(entry) ?? {};
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const change: ChangePreview = {
      label: text(item.label) || `Action ${index + 1}`,
      kind: text(item.kind) || "Recorded action",
      added: count(item.added), removed: count(item.removed),
    };
    for (const key of ["diff", "before", "after", "text", "command", "cwd", "status", "why"] as const) {
      if (typeof item[key] === "string") change[key] = item[key];
    }
    if (Array.isArray(item.annotations)) change.annotations = item.annotations.slice(0, 6).flatMap(value => {
      const note = record(value);
      return note && typeof note.title === "string" && typeof note.why === "string" && Number.isSafeInteger(note.startLine) && Number.isSafeInteger(note.endLine)
        && (note.startLine as number) >= 1 && (note.endLine as number) >= (note.startLine as number)
        ? [{ title: note.title.slice(0, 100), why: note.why.slice(0, 1200), startLine: note.startLine as number, endLine: note.endLine as number }] : [];
    });
    return change;
  });
}

/** Session data predates this renderer and failed validation can save details: {}.
 * Normalize only display data; never infer successful execution or alter the log. */
export function normalizeStepDetails(value: unknown, content: unknown = [], isError = false): StepDetails {
  const data = record(value) ?? {};
  const status = text(data.status)?.trim();
  const contentText = Array.isArray(content) ? content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n") : "";
  const changes = normalizeChanges(data.changes);
  return {
    title: text(data.title) || "Step",
    why: text(data.why) ?? "",
    status: status || (isError ? "Failed" : "Recorded result"),
    note: text(data.note), changes,
    reviewId: text(data.reviewId), revises: text(data.revises),
    proposed: normalizeChanges(data.proposed),
    patch: text(data.patch),
    output: text(data.output) || ((!status || isError && !changes.some((change) => change.text)) ? contentText : undefined),
  };
}

function bounded(context: RenderContext, render: (width: number) => string[]): Component {
  return {
    render(width) {
      const padding = Math.min(context.outputPad ?? 0, Math.max(0, Math.floor((width - 1) / 2)));
      const bodyWidth = Math.max(1, width - padding * 2);
      return render(bodyWidth).map((line) => " ".repeat(padding) + truncateToWidth(line, bodyWidth));
    },
    invalidate() { clearRenderCache(); },
  };
}

export function renderStepCall(args: unknown, theme: Theme, context: RenderContext): Component {
  return bounded(context, (width) => wrapTextWithAnsi(theme.fg("accent", "Step · " + plain(text(record(args)?.title) ?? "Preparing")), width));
}

export function renderStepResult(result: AgentToolResult<unknown>, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
  if (isPartial) return bounded(context, (width) => {
    const data = record(result.details), stream = record(data?.stream);
    const lines = wrapTextWithAnsi(theme.fg("muted", plain(text(data?.status) ?? "Preparing step")), width);
    if (stream) {
      lines.push(theme.fg("accent", "Output · " + plain(stream.status)));
      const output = plain(stream.text).split("\n").flatMap(line => wrapTextWithAnsi(line, width));
      lines.push(...(stream.text ? output.slice(-8) : [theme.fg("dim", "Waiting for output…")]));
      if (output.length > 8 || stream.truncated) lines.push(theme.fg("dim", "Latest output · more in VS Code"));
    }
    return lines;
  });
  const details = normalizeStepDetails(result.details, result.content, context.isError);
  return bounded(context, (width) => {
    const lines: string[] = [];
    const statusColor = context.isError ? "error" : details.status === "Applied" || details.status === "Done" ? "success" : "warning";
    const changes = details.changes ?? [];
    lines.push(theme.fg(statusColor, plain(details.status === "Done" ? "Applied" : details.status)));
    const why = details.why ? new Markdown(plain(details.why), 0, 0, getMarkdownTheme()).render(width) : [];
    lines.push(...(expanded ? why : why.slice(0, 2)));
    if (!expanded && why.length > 2) lines[lines.length - 1] = truncateToWidth(lines[lines.length - 1], Math.max(1, width - 2)) + " …";
    if (details.note) lines.push(...wrapTextWithAnsi(theme.fg("warning", "Your note: " + plain(details.note)), width));
    for (const [index, change] of changes.entries()) {
      const counts = change.diff !== undefined ? ` · +${change.added} −${change.removed}` : "";
      const status = change.status && change.status !== "Applied" ? ` · ${plain(change.status)}` : "";
      lines.push(theme.fg("muted", truncateToWidth(plain(change.label) + counts + status, width)));
      if (expanded) {
        if (change.why) lines.push(...new Markdown(plain(change.why), 0, 0, getMarkdownTheme()).render(width));
        lines.push(...renderChange(change, theme, width, { layout: "auto" }).lines);
        if (context.isError && change.status && /Failed|Stopped/.test(change.status) && details.proposed?.[index]?.diff) {
          lines.push(theme.fg("dim", "Originally proposed — compare with actual result above"));
          lines.push(...renderChange(details.proposed[index], theme, width, { layout: "auto" }).lines);
        }
      } else if (change.status && /Failed|Stopped/.test(change.status) && change.text) {
        // The failure must remain visible even while its full output is collapsed.
        lines.push(...wrapTextWithAnsi(theme.fg("error", plain(change.text)), width).slice(0, 2));
      }
    }
    // Keep old session results readable without passing unified patches to renderDiff.
    if (!changes.length && expanded && details.patch) lines.push(...plain(details.patch).split("\n").flatMap((line) => wrapTextWithAnsi(line, width)));
    if (details.output && (expanded || context.isError || !text(record(result.details)?.status))) {
      const output = plain(details.output).split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
      lines.push(...(expanded ? output : output.slice(0, 3)));
      if (!expanded && output.length > 3) lines.push(theme.fg("dim", "… more output in review details"));
    }
    if (!expanded) lines.push(theme.fg("dim", keyHint("app.tools.expand", "review details")));
    return lines;
  });
}
