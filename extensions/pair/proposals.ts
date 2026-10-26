import { Compile } from "typebox/compile";
import { Type } from "typebox";
import { ChangeSchema, type ChangeInput, type PreparedChange } from "./changes.ts";
import { normalizedFile, snapshot } from "./files.ts";

export const PROPOSAL_ENTRY = "pair-proposal-v1";
export interface SavedProposal {
  id: string; root: string; title: string; why: string;
  changes: ChangeInput[];
  before: Record<string, string>;
}
const validator = Compile(Type.Array(ChangeSchema, { minItems: 1, maxItems: 8 }));
const key = (root: string, change: ChangeInput) => {
  if (!("path" in change)) return "command";
  const path = normalizedFile(root, change.path);
  return process.platform === "win32" ? path.toLowerCase() : path;
};

export function saveProposal(id: string, root: string, title: string, why: string, changes: ChangeInput[], prepared: PreparedChange[]): SavedProposal {
  return { id, root, title, why, changes: structuredClone(changes),
    before: Object.fromEntries(prepared.flatMap(change => change.path && change.before ? [[change.path, change.before.hash]] : [])),
  };
}

/** Revisions operate on the same original files; unrelated drafts remain exact. */
export function reviseProposal(root: string, previous: SavedProposal, replacements: ChangeInput[] = []): ChangeInput[] {
  if (root !== previous.root) throw new Error("This proposal belongs to another project. Prepare a fresh step.");
  for (const [path, hash] of Object.entries(previous.before)) {
    if (snapshot(root, path).hash !== hash) throw new Error(`${path} changed since this proposal. Read it and prepare a fresh step instead of retaining stale edits.`);
  }
  const seen = new Set<string>();
  const changes = structuredClone(previous.changes);
  const hasCommands = changes.some(change => !("path" in change));
  for (const replacement of replacements) {
    if (!("path" in replacement)) throw new Error("To revise commands or action order, submit the complete step without revises.");
    const identity = key(root, replacement);
    if (seen.has(identity)) throw new Error("Supply each revised file once.");
    seen.add(identity);
    const index = changes.findIndex(change => key(root, change) === identity);
    if (index < 0 && hasCommands) throw new Error("To add an action to a step containing commands, submit the complete ordered step without revises.");
    if (index < 0) changes.push(structuredClone(replacement));
    else changes[index] = structuredClone(replacement);
  }
  if (!validator.Check(changes) || changes.filter(change => "path" in change).length > 4) throw new Error("A revision still needs 1–8 ordered actions and at most four file edits/writes.");
  return changes;
}

export function restoredProposal(value: unknown, root: string): SavedProposal | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as SavedProposal;
  if (item.root !== root || typeof item.id !== "string" || !/^[\w-]{8,128}$/.test(item.id)
    || typeof item.title !== "string" || item.title.length > 140 || typeof item.why !== "string" || item.why.length > 1800
    || !validator.Check(item.changes) || !item.before || typeof item.before !== "object" || Array.isArray(item.before)) return;
  const entries = Object.entries(item.before);
  if (entries.length > 4 || entries.some(([path, hash]) => typeof hash !== "string" || hash.length > 128 || typeof path !== "string")) return;
  try {
    const files = item.changes.filter((change): change is ChangeInput & { path: string } => "path" in change).map(change => normalizedFile(root, change.path));
    const identities = files.map(path => process.platform === "win32" ? path.toLowerCase() : path);
    if (new Set(identities).size !== files.length || files.length !== entries.length || files.some(path => !Object.hasOwn(item.before, path))) return;
    return structuredClone(item);
  } catch { return; }
}
