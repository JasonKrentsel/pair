import { structuredPatch } from "diff";

/** Frozen review data. These snapshots belong to UI details, never model-facing content. */
export interface ChangePreview {
  label: string;
  kind: string;
  /** Legacy Pi display diff, retained for existing sessions. */
  diff?: string;
  before?: string;
  after?: string;
  text?: string;
  command?: string;
  cwd?: string;
  added: number;
  removed: number;
  status?: string;
  /** Markdown explanations are display data, never executable tool input. */
  why?: string;
  annotations?: { title: string; why: string; startLine: number; endLine: number }[];
}

export interface ReviewLine {
  kind: "context" | "add" | "remove" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface ReviewHunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: ReviewLine[];
}

export function normalizeSource(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
}

/** Render controls visibly; never execute terminal escape sequences from source files. */
export function displaySource(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    (character) => "\\x" + character.charCodeAt(0).toString(16).padStart(2, "0"));
}

export function reviewHunks(before: string, after: string): ReviewHunk[] {
  const patch = structuredPatch("before", "proposed", normalizeSource(before), normalizeSource(after), undefined, undefined, { context: 3 });
  return patch.hunks.map((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: ReviewLine[] = hunk.lines.map((line) => {
      const text = displaySource(line.slice(1));
      if (line[0] === "+") return { kind: "add", text, newLine: newLine++ };
      if (line[0] === "-") return { kind: "remove", text, oldLine: oldLine++ };
      if (line[0] === " ") return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
      return { kind: "meta", text: line.replace(/^\\ /, "") };
    });
    return { oldStart: hunk.oldStart, newStart: hunk.newStart, oldCount: hunk.oldLines, newCount: hunk.newLines, lines };
  });
}
