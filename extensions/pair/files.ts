import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { FileSnapshot, Increment } from "./state.ts";

const MAX_FILE_BYTES = 256 * 1024;

// Constrain extension-owned writes and built-in edit/write to ordinary project files.
export function projectFile(root: string, input: string): string {
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Choose a file inside the active project.");
  }
  const parts = rel.split(sep);
  if (parts.some((part) => part.includes(":"))) throw new Error("Alternate file streams are not supported.");
  if (parts.some((part) => [".git", "node_modules", ".pi", ".agents"].includes(part.toLowerCase()))) {
    throw new Error("Pair does not edit repository metadata, installed dependencies, or agent configuration.");
  }
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic links require manual handling: ${rel}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return absolute;
}

export function projectRoot(cwd: string): string {
  return realpathSync(cwd);
}

export function normalizedFile(root: string, input: string): string {
  return relative(root, projectFile(root, input)).split(sep).join("/");
}

export function snapshot(root: string, file: string): FileSnapshot {
  const path = projectFile(root, file);
  if (!existsSync(path)) return { exists: false, hash: "missing" };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Expected an ordinary file: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the 256 KiB review limit: ${file}`);
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error(`Binary files require manual review: ${file}`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`Expected UTF-8 text: ${file}`);
  return { exists: true, text, hash: createHash("sha256").update(bytes).digest("hex") };
}

export function changedSinceObservation(root: string, increment: Increment): string[] {
  return Object.entries(increment.expected)
    .filter(([file, hash]) => snapshot(root, file).hash !== hash)
    .map(([file]) => file);
}

export function observeFiles(root: string, increment: Increment): Increment {
  const expected: Record<string, string> = Object.create(null);
  for (const file of increment.files) expected[file] = snapshot(root, file).hash;
  return { ...increment, expected };
}

export function reviewDiff(root: string, increment?: Increment): string {
  if (!increment || !Object.keys(increment.baseline).length) return "No approved increment baseline yet.";
  const patches: string[] = [];
  for (const [file, before] of Object.entries(increment.baseline)) {
    const after = snapshot(root, file);
    if (before.hash === after.hash) continue;
    patches.push(createTwoFilesPatch(
      before.exists ? `before/${file}` : "/dev/null",
      after.exists ? `after/${file}` : "/dev/null",
      before.text ?? "", after.text ?? "", "at approval", "current working file", { context: 3 },
    ));
  }
  return patches.join("\n") || "No changes in the increment's files.";
}

export function saveDesign(root: string, path: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Design exceeds 256 KiB.");
  const absolute = projectFile(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}
