import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv"]);
const pathParameter = Type.String({ maxLength: 4096, description: "Path inside this project; relative paths use the project root." });
const optionalPath = Type.Optional(pathParameter);
const propertiesOnly = { additionalProperties: false };
const readSchema = Type.Object({ path: pathParameter, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, propertiesOnly);
const lsSchema = Type.Object({ path: optionalPath, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }, propertiesOnly);
const findSchema = Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 500 }), path: optionalPath, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }, propertiesOnly);
const grepSchema = Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 500 }), path: optionalPath, glob: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), ignoreCase: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, propertiesOnly);

function checkedInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("Tool arguments do not match the read tool's schema.");
  return value;
}

function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

function cancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function output(text: string) {
  const bytes = Buffer.from(text, "utf8");
  const notice = "\n\n[Output limited to 32 KiB. Narrow the path or request fewer results.]";
  const clipped = bytes.length <= MAX_OUTPUT_BYTES ? text
    : bytes.subarray(0, MAX_OUTPUT_BYTES - Buffer.byteLength(notice) - 3).toString("utf8") + notice;
  return { content: [{ type: "text" as const, text: clipped }], details: {} };
}

function integer(value: number | undefined, fallback: number, max: number, name: string, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return result;
}

function checkedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new Error(`${name} must be nonempty text of at most ${max} characters.`);
  return value;
}

function checkedGlob(value: unknown): string {
  const pattern = checkedString(value, "Glob", 500).replace(/\\/g, "/");
  // Keep matching predictable: nested brace expansion and extended globs can
  // multiply work long before the bounded file traversal starts.
  if (/[{}()]/.test(pattern) || pattern.startsWith("!")) throw new Error("Use a simple glob with *, **, ? or character classes; brace expansion, extglobs and negation are unavailable.");
  return pattern;
}

/**
 * Follow-up tools operate on project text only. No shell, subprocess, ambient
 * extension tool, or filesystem write capability is reachable from these tools.
 */
export function createActionReadTools(root: string): AgentTool[] {
  const lexicalRoot = resolve(root);
  let rootPromise: Promise<string> | undefined;
  const canonicalRoot = () => rootPromise ??= realpath(lexicalRoot);

  async function checkedPath(input = ".", signal?: AbortSignal): Promise<string> {
    cancelled(signal);
    checkedString(input, "Path", 4096);
    const requested = resolve(lexicalRoot, input);
    if (!inside(lexicalRoot, requested)) throw new Error("Read paths must stay inside this project.");
    const base = await canonicalRoot();
    let actual: string;
    try { actual = await realpath(requested); }
    catch { throw new Error(`Project path was not found or is unreadable: ${JSON.stringify(input)}`); }
    cancelled(signal);
    if (!inside(base, actual)) throw new Error("This path resolves outside the project, including through a symlink or junction.");
    return actual;
  }

  // Canonical paths returned by traversal still pass both containment checks.
  async function checkedCanonicalPath(input: string, signal?: AbortSignal): Promise<string> {
    const base = await canonicalRoot();
    if (!inside(base, input)) throw new Error("Read paths must stay inside this project.");
    const actual = await realpath(input);
    cancelled(signal);
    if (!inside(base, actual)) throw new Error("The path changed or resolves outside the project.");
    return actual;
  }

  async function textFile(input: string, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
    const actual = await checkedCanonicalPath(input, signal);
    const handle = await open(actual, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Only regular text files can be read.");
      if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes / 1024} KiB text-read limit. Choose a smaller file.`);
      // Check the opened handle against the still-contained named file before
      // reading, so a replaced link/path cannot silently redirect a read.
      const current = await checkedCanonicalPath(actual, signal);
      const named = await stat(current);
      if (info.dev !== named.dev || info.ino !== named.ino) throw new Error("The file changed while opening it. Retry the read.");
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        cancelled(signal);
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maxBytes) throw new Error("The file grew beyond the read limit. Choose a smaller file.");
      const after = await handle.stat();
      const afterPath = await checkedCanonicalPath(actual, signal);
      const namedAfter = await stat(afterPath);
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
        || namedAfter.dev !== info.dev || namedAfter.ino !== info.ino || namedAfter.size !== info.size
        || namedAfter.mtimeMs !== info.mtimeMs || namedAfter.ctimeMs !== info.ctimeMs)
        throw new Error("The file changed while reading it. Retry the read.");
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) throw new Error("Only UTF-8 text files are available in this chat.");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("Only UTF-8 text files are available in this chat."); }
      return { text, bytes: length };
    } finally { await handle.close(); }
  }

  async function directoryEntries(directory: string, limit: number, signal?: AbortSignal): Promise<{ entries: Dirent[]; limited: boolean }> {
    const actual = await checkedCanonicalPath(directory, signal);
    const reader = await opendir(actual);
    const entries: Dirent[] = [];
    let limited = false;
    try {
      for (;;) {
        cancelled(signal);
        const entry = await reader.read();
        if (!entry) break;
        if (entries.length >= limit) { limited = true; break; }
        entries.push(entry);
      }
    } finally { await reader.close(); }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { entries, limited };
  }

  async function filesUnder(input = ".", signal?: AbortSignal): Promise<{ base: string; files: string[]; limited: boolean }> {
    const base = await checkedPath(input, signal);
    const initial = await stat(base);
    if (initial.isFile()) return { base, files: [base], limited: false };
    if (!initial.isDirectory()) throw new Error("Choose a regular file or project directory.");
    const queue = [base], visited = new Set<string>(), files: string[] = [];
    let count = 0, limited = false;
    while (queue.length && count < MAX_ENTRIES) {
      cancelled(signal);
      const directory = queue.shift()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      const listed = await directoryEntries(directory, MAX_ENTRIES - count, signal);
      count += listed.entries.length;
      limited ||= listed.limited;
      for (const entry of listed.entries) {
        cancelled(signal);
        // Windows junctions are reported as symbolic links. Canonical checks
        // also reject platform-specific links that point outside the root.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        let child: string;
        try { child = await checkedCanonicalPath(join(directory, entry.name), signal); }
        catch { cancelled(signal); continue; }
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile()) files.push(child);
      }
    }
    limited ||= queue.length > 0;
    files.sort();
    return { base, files, limited };
  }

  const displayPath = (file: string, base: string) => (relative(base, file) || file.split(/[\\/]/).at(-1)!).replace(/\\/g, "/");
  const matchGlob = (file: string, pattern: string) => matchesGlob(file, pattern) || !pattern.includes("/") && matchesGlob(file.split("/").at(-1)!, pattern);

  return [
    {
      name: "read", label: "Read project text",
      description: "Read a UTF-8 project file without changing it. Uses 1-based line offsets; at most 300 lines, 1 MiB input and 32 KiB output. Paths must resolve inside this project.",
      parameters: readSchema,
      async execute(_id, value, signal) {
        const input = checkedInput(readSchema, value);
        const offset = integer(input.offset, 1, Number.MAX_SAFE_INTEGER, "offset");
        const limit = integer(input.limit, 200, 300, "limit");
        const file = await checkedPath(input.path, signal), { text } = await textFile(file, MAX_READ_BYTES, signal);
        const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
        if (offset > lines.length) throw new Error(`Offset ${offset} is past the file's ${lines.length} lines.`);
        const end = Math.min(lines.length, offset + limit - 1);
        return output(lines.slice(offset - 1, end).map((line, index) => `${offset + index}: ${line}`).join("\n")
          + (end < lines.length ? `\n\n[${lines.length - end} more lines. Continue with offset=${end + 1}.]` : ""));
      },
    },
    {
      name: "ls", label: "List project directory",
      description: "List a project directory, including dotfiles, sorted by name. Skips symlink/junction entries. At most 500 results and 5,000 inspected entries. Does not execute a shell.",
      parameters: lsSchema,
      async execute(_id, value, signal) {
        const input = checkedInput(lsSchema, value);
        const limit = integer(input.limit, 100, 500, "limit"), directory = await checkedPath(input.path, signal);
        if (!(await stat(directory)).isDirectory()) throw new Error("Choose a directory to list.");
        const { entries, limited } = await directoryEntries(directory, MAX_ENTRIES, signal), result: string[] = [];
        for (const entry of entries) {
          cancelled(signal);
          if (entry.isSymbolicLink()) continue;
          try { await checkedCanonicalPath(join(directory, entry.name), signal); }
          catch { cancelled(signal); continue; }
          result.push(entry.name + (entry.isDirectory() ? "/" : ""));
        }
        return output((result.slice(0, limit).join("\n") || "(empty directory)")
          + (limited || result.length > limit ? "\n\n[Listing limited. Choose a narrower directory or increase limit up to 500.]" : ""));
      },
    },
    {
      name: "find", label: "Find project files",
      description: "Find project files by simple glob (*, **, ?, character classes), such as '*.ts' or 'src/**/*.py'; no brace expansion, extglobs or negation. Skips symlink/junction entries and .git, node_modules, .venv, venv directories; does not evaluate .gitignore. At most 500 results and 5,000 inspected entries.",
      parameters: findSchema,
      async execute(_id, value, signal) {
        const input = checkedInput(findSchema, value);
        const pattern = checkedGlob(input.pattern), limit = integer(input.limit, 100, 500, "limit");
        const scan = await filesUnder(input.path, signal);
        const matches = scan.files.map(file => displayPath(file, scan.base)).filter(file => matchGlob(file, pattern));
        return output((matches.slice(0, limit).join("\n") || "No matching files.")
          + (scan.limited || matches.length > limit ? "\n\n[Search limited. Narrow the path or pattern.]" : ""));
      },
    },
    {
      name: "grep", label: "Search project text",
      description: "Search project files for literal text (not regular expressions). Returns file paths and line numbers. Optional glob and up to 3 context lines. Skips symlink/junction entries, dependency/Git directories, binary files and files above 512 KiB; scans at most 8 MiB / 5,000 entries. Does not evaluate .gitignore or execute a shell.",
      parameters: grepSchema,
      async execute(_id, value, signal) {
        const input = checkedInput(grepSchema, value);
        const needle = checkedString(input.pattern, "Pattern", 500), limit = integer(input.limit, 100, 200, "limit");
        const context = integer(input.context, 0, 3, "context", 0), scan = await filesUnder(input.path, signal);
        const pattern = input.ignoreCase ? needle.toLowerCase() : needle;
        const glob = input.glob === undefined ? undefined : checkedGlob(input.glob);
        const result: string[] = [];
        let readBytes = 0, matches = 0, limited = scan.limited, skipped = 0;
        for (const file of scan.files) {
          cancelled(signal);
          const label = displayPath(file, scan.base);
          if (glob && !matchGlob(label, glob)) continue;
          let size: number;
          try { size = (await stat(file)).size; }
          catch { cancelled(signal); skipped++; continue; }
          if (size > MAX_SEARCH_FILE_BYTES) { skipped++; continue; }
          if (readBytes + size > MAX_SEARCH_BYTES) { limited = true; break; }
          let content: { text: string; bytes: number };
          try { content = await textFile(file, Math.min(MAX_SEARCH_FILE_BYTES, MAX_SEARCH_BYTES - readBytes), signal); }
          catch { cancelled(signal); skipped++; continue; }
          readBytes += content.bytes;
          const lines = content.text.replace(/\r\n|\r/g, "\n").split("\n");
          for (let index = 0; index < lines.length; index++) {
            if (!(input.ignoreCase ? lines[index].toLowerCase() : lines[index]).includes(pattern)) continue;
            matches++;
            for (let current = Math.max(0, index - context); current <= Math.min(lines.length - 1, index + context); current++)
              result.push(`${label}${current === index ? ":" : "-"}${current + 1}: ${lines[current].slice(0, 2000)}${lines[current].length > 2000 ? " [line truncated]" : ""}`);
            if (matches >= limit) { limited = true; break; }
          }
          if (matches >= limit || Buffer.byteLength(result.join("\n"), "utf8") >= MAX_OUTPUT_BYTES) { limited = true; break; }
        }
        return output((result.join("\n") || "No matching text.") + (limited ? "\n\n[Search limited. Narrow the path, glob or pattern.]" : "") + (skipped ? `\n\n[${skipped} unreadable, binary or oversized file(s) skipped.]` : ""));
      },
    },
  ];
}
