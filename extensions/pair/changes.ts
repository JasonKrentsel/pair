import { createEditTool, generateDiffString } from "@earendil-works/pi-coding-agent";
import { diffLines } from "diff";
import { Type, type Static } from "typebox";
import { normalizedFile, projectFile, snapshot } from "./files.ts";
import type { FileSnapshot } from "./state.ts";
import type { ChangePreview } from "./review-model.ts";

const Explanation = {
  why: Type.Optional(Type.String({ minLength: 1, maxLength: 1600, description: "Concise Markdown explanation for this file or command; explain its purpose and meaningful choices." })),
  annotations: Type.Optional(Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 100 }),
    why: Type.String({ minLength: 1, maxLength: 1200, description: "Markdown explaining this consequential section, not a copy of its code." }),
    startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }), { maxItems: 6, description: "Optional explanations anchored to 1-based lines in the complete proposed file or command, never diff/hunk line numbers. Select actual code; omit blank-only ranges and obvious edits." })),
};
export const ChangeSchema = Type.Union([
  Type.Object({ tool: Type.Literal("edit"), path: Type.String({ minLength: 1 }), edits: Type.Array(Type.Object({
    oldText: Type.String({ minLength: 1, maxLength: 60000 }), newText: Type.String({ maxLength: 60000 }),
  }), { minItems: 1, maxItems: 10 }), ...Explanation }),
  Type.Object({ tool: Type.Literal("write"), path: Type.String({ minLength: 1 }), content: Type.String({ maxLength: 60000 }), ...Explanation }),
  Type.Object({ tool: Type.Union([Type.Literal("bash"), Type.Literal("powershell")]), command: Type.String({ minLength: 1, maxLength: 4000 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })), interactive: Type.Optional(Type.Boolean({ description: "Use a real PTY for input prompts, progress redraws or terminal applications. Requires connected VS Code; keyboard input is live after approval." })), ...Explanation }),
]);
export type ChangeInput = Static<typeof ChangeSchema>;
export interface PreparedChange {
  tool: ChangeInput["tool"];
  input: Record<string, unknown>;
  path?: string;
  before?: FileSnapshot;
  after?: string;
  preview: ChangePreview;
}

function explanation(change: ChangeInput, source: string): Pick<ChangePreview, "why" | "annotations"> {
  const lines = source.replace(/\r\n|\r/g, "\n").split("\n").length;
  for (const annotation of change.annotations ?? []) {
    if (annotation.endLine < annotation.startLine || annotation.endLine > lines) throw new Error(`Explanation ${annotation.title.slice(0, 100)} must reference existing proposed lines 1–${lines}.`);
  }
  return { ...(change.why ? { why: change.why } : {}), ...(change.annotations?.length ? { annotations: structuredClone(change.annotations) } : {}) };
}

export function filePreview(path: string, before: string, after: string, kind: string): ChangePreview {
  const oldText = before.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
  const newText = after.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
  const endings = (text: string) => {
    const rest = text.replace(/\r\n/g, "");
    return [text.includes("\r\n") ? "CRLF" : "", rest.includes("\n") ? "LF" : "", rest.includes("\r") ? "CR" : ""].filter(Boolean).join(" + ") || "none";
  };
  const notes: string[] = [];
  if (before.startsWith("\uFEFF") !== after.startsWith("\uFEFF")) notes.push(`UTF-8 BOM ${after.startsWith("\uFEFF") ? "added" : "removed"}.`);
  if (endings(before) !== endings(after) && endings(before) !== "none" && endings(after) !== "none") {
    notes.push(`Line endings: ${endings(before)} → ${endings(after)}.`);
  }
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) removed += part.count ?? 0;
  }
  return { label: path, kind, before, after, diff: generateDiffString(oldText, newText).diff, text: notes.join("\n") || undefined, added, removed };
}

/** Prepare every file before requesting permission. No filesystem writes occur here. */
export async function prepareChanges(root: string, changes: ChangeInput[], signal?: AbortSignal): Promise<PreparedChange[]> {
  if (!changes.length || changes.length > 8) throw new Error("Choose one coherent step with 1–8 ordered actions.");
  if (changes.filter(change => "path" in change).length > 4) throw new Error("A step can edit or write at most four distinct files. Split larger work into another step.");
  const paths = new Set<string>();
  // Diagnose structural problems before explanations or file preview work.
  for (const change of changes) {
    if (!("path" in change)) continue;
    const path = normalizedFile(root, change.path);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (paths.has(key)) throw new Error(`Combine all replacements in ${path} into one edit entry.`);
    paths.add(key);
  }
  if (paths.size && paths.size < changes.length) {
    const missing = changes.findIndex(change => !change.why?.trim());
    if (missing >= 0) throw new Error(`Action ${missing + 1}: add why explaining this action before requesting approval.`);
  }
  const prepared: PreparedChange[] = [];
  for (const change of changes) {
    signal?.throwIfAborted();
    const { tool, why: _why, annotations: _annotations, ...input } = structuredClone(change);
    if (!("path" in change)) {
      prepared.push({ tool, input, preview: { label: change.command.replace(/\r\n|\r/g,"\n"), kind: tool, command: change.command, cwd: root, interactive: !!change.interactive, added: 0, removed: 0, ...explanation(change, change.command) } });
      continue;
    }
    const path = normalizedFile(root, change.path);
    const absolute = projectFile(root, path);
    const before = snapshot(root, path);
    let after: string;
    if (change.tool === "write") after = change.content;
    else {
      if (!before.exists) throw new Error(`Read ${path} before editing, or use write for a new file.`);
      let proposed: string | undefined;
      const assertTarget = (target: string) => {
        const same = process.platform === "win32" ? target.toLowerCase() === absolute.toLowerCase() : target === absolute;
        if (!same) throw new Error("Edit preview tried to access a different file.");
      };
      // Reuse Pi's matching, overlap checks, BOM handling, and line-ending behavior.
      // The preview operations are entirely in memory; the actual native edit runs only after approval.
      const edit = createEditTool(root, { operations: {
        readFile: async (target) => { assertTarget(target); return Buffer.from(before.text!, "utf8"); },
        access: async (target) => { assertTarget(target); },
        writeFile: async (target, content) => { assertTarget(target); proposed = content; },
      } });
      await edit.execute("pair-preview", { path: absolute, edits: change.edits }, signal);
      if (proposed === undefined) throw new Error(`Could not preview the edit to ${path}.`);
      after = proposed;
    }
    if (Buffer.byteLength(after) > 256 * 1024 || after.includes("\0")) throw new Error(`Proposed file exceeds text preview limits: ${path}`);
    if (before.text === after) throw new Error(`No change in ${path}; remove it from the request.`);
    prepared.push({ tool, input: { ...input, path: absolute }, path, before, after,
      preview: { ...filePreview(path, before.text ?? "", after, before.exists ? "Edit" : "New file"), ...explanation(change, after) },
    });
  }
  return prepared;
}

export function assertUnchanged(root: string, changes: PreparedChange[]): void {
  for (const change of changes) {
    if (change.path && snapshot(root, change.path).hash !== change.before?.hash) {
      throw new Error(`${change.path} changed since the preview. Read it and request fresh permission; remaining changes were not run.`);
    }
  }
}
