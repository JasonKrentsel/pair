import { diffLines } from "diff";
import { assertUnchanged, prepareChanges, type ChangeInput, type PreparedChange } from "./changes.ts";

export interface ActionLineScope { startLine: number; endLine: number }
const MAX_CONTENT = 256 * 1024;
const MAX_EDIT_TEXT = 60000;
const lineEnding = (text: string) => text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
const normalize = (text: string) => text.replace(/\r\n|\r/g, "\n");

/** Replace full proposed lines, retaining every byte outside that selection. */
function spliceLines(source: string, content: string, scope?: ActionLineScope): string {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? source.slice(1) : source;
  const replacement = bom && content.startsWith(bom) ? content.slice(1) : content;
  if (!scope) return bom + normalize(replacement).replace(/\n/g, lineEnding(text));
  const lines: Array<{ start: number; end: number; separator: string }> = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ start, end: match.index!, separator: match[0] });
    start = match.index! + match[0].length;
  }
  lines.push({ start, end: text.length, separator: "" });
  if (!Number.isSafeInteger(scope.startLine) || !Number.isSafeInteger(scope.endLine)
    || scope.startLine < 1 || scope.endLine < scope.startLine || scope.endLine > lines.length) {
    throw new Error(`Choose existing proposed lines 1–${lines.length}.`);
  }
  const first = lines[scope.startLine - 1], last = lines[scope.endLine - 1];
  // The original separator after the selected range is outside its editable body.
  // A model may include that separator once; consume it instead of doubling it.
  const body = last.separator ? replacement.replace(/(?:\r\n|\r|\n)$/, "") : replacement;
  const ending = lines.slice(scope.startLine - 1, scope.endLine).find(line => line.separator)?.separator ?? lineEnding(text);
  const revised = normalize(body).replace(/\n/g, ending);
  return bom + text.slice(0, first.start) + revised + text.slice(last.end);
}

interface Block { beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number }
function merge(left: Block, right: Block): Block {
  return { beforeStart: left.beforeStart, beforeEnd: right.beforeEnd, afterStart: left.afterStart, afterEnd: right.afterEnd };
}

/** Derive small, unique native replacements against the ORIGINAL disk baseline. */
function exactEdits(beforeRaw: string, afterRaw: string): Array<{ oldText: string; newText: string }> {
  const before = normalize(beforeRaw.replace(/^\uFEFF/, "")), after = normalize(afterRaw.replace(/^\uFEFF/, ""));
  if (!before.length) throw new Error("This empty file needs a new write proposal rather than an edit revision.");
  const blocks: Block[] = [];
  let beforePos = 0, afterPos = 0, current: Block | undefined;
  for (const part of diffLines(before, after)) {
    if (part.added || part.removed) {
      current ??= { beforeStart: beforePos, beforeEnd: beforePos, afterStart: afterPos, afterEnd: afterPos };
      if (part.removed) beforePos += part.value.length; else afterPos += part.value.length;
      current.beforeEnd = beforePos; current.afterEnd = afterPos;
    } else {
      if (current) { blocks.push(current); current = undefined; }
      beforePos += part.value.length; afterPos += part.value.length;
    }
  }
  if (current) blocks.push(current);
  if (!blocks.length) throw new Error("The revision does not change the proposed action.");
  // The public step supports ten native replacements. Merge the closest adjacent
  // blocks only when necessary; do not turn a small fix into a whole-file write.
  while (blocks.length > 10) {
    let closest = 0;
    for (let i = 1; i < blocks.length - 1; i++) {
      if (blocks[i + 1].beforeStart - blocks[i].beforeEnd < blocks[closest + 1].beforeStart - blocks[closest].beforeEnd) closest = i;
    }
    blocks.splice(closest, 2, merge(blocks[closest], blocks[closest + 1]));
  }
  for (;;) {
    const edits: Array<{ oldText: string; newText: string }> = [];
    let previousEnd = 0, restart = false;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i], leftRoom = block.beforeStart - previousEnd;
      const rightRoom = (blocks[i + 1]?.beforeStart ?? before.length) - block.beforeEnd;
      let context = 0;
      for (;;) {
        const left = Math.min(context, leftRoom), right = Math.min(context, rightRoom);
        const oldText = before.slice(block.beforeStart - left, block.beforeEnd + right);
        const newText = after.slice(block.afterStart - left, block.afterEnd + right);
        const first = oldText ? before.indexOf(oldText) : -1;
        if (first === block.beforeStart - left && before.indexOf(oldText, first + 1) === -1) {
          if (oldText.length > MAX_EDIT_TEXT || newText.length > MAX_EDIT_TEXT) throw new Error("This revision is too broad. Select a smaller section or request a fresh step.");
          edits.push({ oldText, newText }); previousEnd = block.beforeEnd + right; break;
        }
        if (left === leftRoom && right === rightRoom) {
          if (blocks.length === 1) throw new Error("The revised edit could not be anchored uniquely. Request a fresh step.");
          const neighbor = i + 1 < blocks.length ? i : i - 1;
          blocks.splice(neighbor, 2, merge(blocks[neighbor], blocks[neighbor + 1]));
          restart = true; break;
        }
        context = context ? context * 2 : 24;
      }
      if (restart) break;
    }
    if (!restart) return edits;
  }
}

/**
 * Build one replacement proposal in memory. Callers still own candidate identity,
 * acceptance and fresh approval. This helper never writes or executes anything.
 * With scope, content replaces those full proposed lines; without it, the full
 * proposed file/command. Sibling actions retain the exact same objects and bytes.
 */
export async function buildActionRevision(root: string, prepared: PreparedChange[], index: number, content: string, summary: string, scope?: ActionLineScope, signal?: AbortSignal): Promise<PreparedChange[]> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(index) || index < 0 || index >= prepared.length) throw new Error("Choose one action in the pending step.");
  if (typeof content !== "string" || content.includes("\0") || Buffer.from(content,"utf8").toString("utf8") !== content || Buffer.byteLength(content) > MAX_CONTENT) throw new Error("The revision must be UTF-8 text within the 256 KiB preview limit.");
  if (typeof summary !== "string" || !summary.trim() || summary.length > 1600) throw new Error("Explain the revision in 1–1600 characters.");
  assertUnchanged(root, prepared);
  const selected = prepared[index], source = selected.path ? selected.after : selected.preview.command;
  if (typeof source !== "string") throw new Error("This action has no complete proposed text to revise.");
  const revised = spliceLines(source, content, scope);
  if (revised === source) throw new Error("The revision does not change the proposed action.");
  if (Buffer.byteLength(revised) > MAX_CONTENT) throw new Error("The revised file exceeds the 256 KiB preview limit.");
  const input: Record<string, unknown> = { ...structuredClone(selected.input) };
  if (selected.tool === "edit") input.edits = exactEdits(selected.before?.text ?? "", revised);
  else if (selected.tool === "write") {
    if (revised.length > MAX_EDIT_TEXT) throw new Error("A proposed write must contain at most 60000 characters.");
    input.content = revised;
  } else {
    if (!revised.trim() || revised.length > 4000) throw new Error("A revised command must contain 1–4000 characters.");
    input.command = revised;
  }
  // Reuse Pi's native edit preview engine. It verifies matching, non-overlap,
  // BOMs and line endings using memory-only write operations.
  const [next] = await prepareChanges(root, [{ ...input, tool: selected.tool, why: summary.trim() } as ChangeInput], signal);
  signal?.throwIfAborted();
  assertUnchanged(root, prepared);
  if (next.tool !== selected.tool || next.path !== selected.path
    || (selected.path ? next.after : next.preview.command) !== revised
    || next.before?.hash !== selected.before?.hash) {
    throw new Error("The revision cannot be represented exactly by the original action. Request a fresh step.");
  }
  const result = prepared.slice();
  // Old section annotations are invalid after source line changes. The human's
  // new rationale remains, without pretending old anchors still point at it.
  result[index] = { ...next, before: selected.before };
  return result;
}
