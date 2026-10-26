import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

export interface DiffSnapshot { directory: string; before: string; after: string }

export function writeDiffSnapshots(label: string, before: string, after: string, temporaryRoot = tmpdir()): DiffSnapshot {
  const directory = mkdtempSync(join(temporaryRoot, "pi-pair-review-"));
  const filename = basename(label.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "file.txt";
  mkdirSync(join(directory, "before"));
  mkdirSync(join(directory, "proposed"));
  const paths = { directory, before: join(directory, "before", filename), after: join(directory, "proposed", filename) };
  writeFileSync(paths.before, before, { mode: 0o600 });
  writeFileSync(paths.after, after, { mode: 0o600 });
  return paths;
}

export function findCodeExecutable(env = process.env, platform = process.platform): string | undefined {
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (base) candidates.push(join(base, "Microsoft VS Code", "Code.exe"));
    }
    for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(join(entry, "Code.exe"), resolve(entry, "..", "Code.exe"));
    }
  } else for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(entry, "code"));
  return candidates.find((path) => existsSync(path));
}

export function companionInstalled(home = homedir()): boolean {
  try { return readdirSync(join(home, ".vscode", "extensions")).some(name => name.startsWith("local-pair.pi-pair-") && existsSync(join(home, ".vscode", "extensions", name, "package.json"))); }
  catch { return false; }
}

async function launchCode(args: string[]): Promise<void> {
  const executable = findCodeExecutable();
  if (!executable) throw new Error("VS Code was not found. Install it or put its launcher on PATH; this proposal remains pending.");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export function codeReviewArguments(root: string): string[] {
  // Folder identity, never --reuse-window on an unrelated last-active project.
  // --open-url consumes ALL positional arguments as URLs, including a folder.
  // The companion consumes the session's explicit focus request after discovery.
  return [resolve(root), "--skip-add-to-recently-opened"];
}

export async function openCodeReview(root: string): Promise<void> {
  await launchCode(codeReviewArguments(root));
}

export async function openCodeDiff(label: string, before: string, after: string, root?: string): Promise<DiffSnapshot> {
  const snapshot = writeDiffSnapshots(label, before, after);
  await launchCode([...(root ? [resolve(root)] : []), "--skip-add-to-recently-opened", "--diff", snapshot.before, snapshot.after]);
  // Keep snapshots in the OS temporary directory: VS Code can read them after the
  // review closes. They are never reread as execution inputs or written to the project.
  return snapshot;
}
