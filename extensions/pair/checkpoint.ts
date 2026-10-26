import { randomUUID } from "node:crypto";

export interface Checkpoint {
  objective: string;
  implemented: string;
  verification: string;
  usable: string;
  deferred: string;
  next: string;
  revision: number;
  updatedAt: string;
  stale: boolean;
}
export interface Constraint { id: string; text: string; scope: "task" | "turn"; createdAt: string; pendingTurn?: boolean }
export interface WorkMemory { revision: number; checkpoint?: Checkpoint; constraints: Constraint[] }
export type CheckpointPatch = Partial<Pick<Checkpoint, "objective" | "implemented" | "verification" | "usable" | "deferred" | "next">>;

export const CHECKPOINT_LIMITS = { objective: 240, implemented: 600, verification: 600, usable: 600, deferred: 600, next: 300 } as const;
const fields = Object.keys(CHECKPOINT_LIMITS) as (keyof CheckpointPatch)[];
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const safeRevision = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
const timestamp = (value: unknown): string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : "";
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nextRevision = (revision: number): number => {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("The checkpoint revision cannot be advanced. Start new Pair work.");
  return revision + 1;
};

function validText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length <= limit && !controls.test(value);
}

/** Missing or malformed saved data never becomes evidence of completed work. */
export function normalizeMemory(value: unknown): WorkMemory {
  if (!isRecord(value)) return { revision: 0, constraints: [] };
  const memory: WorkMemory = { revision: safeRevision(value.revision), constraints: [] };
  const seen = new Set<string>();
  if (Array.isArray(value.constraints)) for (const candidate of value.constraints) {
    if (memory.constraints.length >= 12) break;
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(candidate.id) || seen.has(candidate.id)) continue;
    if (!validText(candidate.text, 300) || !candidate.text.trim() || !["task", "turn"].includes(String(candidate.scope))) continue;
    seen.add(candidate.id);
    memory.constraints.push({ id: candidate.id, text: candidate.text.trim(), scope: candidate.scope as Constraint["scope"], createdAt: timestamp(candidate.createdAt),
      ...(candidate.scope === "turn" && candidate.pendingTurn === true ? { pendingTurn: true } : {}),
    });
  }
  const checkpoint = value.checkpoint;
  if (isRecord(checkpoint) && fields.every(field => validText(checkpoint[field], CHECKPOINT_LIMITS[field])) && fields.some(field => String(checkpoint[field]).trim())) {
    memory.checkpoint = {
      ...Object.fromEntries(fields.map(field => [field, (checkpoint[field] as string).trim()])) as Pick<Checkpoint, keyof CheckpointPatch>,
      revision: safeRevision(checkpoint.revision), updatedAt: timestamp(checkpoint.updatedAt), stale: checkpoint.stale === true,
    };
  }
  return memory;
}

/** Updates only the agent's report. Human constraints are never edited here. */
export function updateCheckpoint(memory: WorkMemory, patch: CheckpointPatch): WorkMemory {
  if (!isRecord(patch) || !Object.keys(patch).length || Object.keys(patch).some(field => !fields.includes(field as keyof CheckpointPatch))) throw new Error("Supply one or more checkpoint fields: objective, implemented, verification, usable, deferred, next.");
  for (const field of fields) if (field in patch && !validText(patch[field], CHECKPOINT_LIMITS[field])) throw new Error(`Checkpoint ${field} must be text of at most ${CHECKPOINT_LIMITS[field]} characters without terminal controls.`);
  const previous = memory.checkpoint;
  const content = Object.fromEntries(fields.map(field => [field, field in patch ? patch[field]!.trim() : previous?.[field] ?? ""])) as Pick<Checkpoint, keyof CheckpointPatch>;
  if (!fields.some(field => content[field])) throw new Error("Record a meaningful checkpoint before saving it.");
  // A next-step update is not new evidence that old checks remain current.
  const stale = previous?.stale === true && !("verification" in patch);
  if (previous && previous.stale === stale && fields.every(field => previous[field] === content[field])) return memory;
  return {
    ...memory, revision: nextRevision(memory.revision),
    checkpoint: { ...content, revision: nextRevision(previous?.revision ?? 0), updatedAt: new Date().toISOString(), stale },
  };
}

export function markCheckpointStale(memory: WorkMemory): WorkMemory {
  if (!memory.checkpoint || memory.checkpoint.stale) return memory;
  return { ...memory, revision: nextRevision(memory.revision), checkpoint: { ...memory.checkpoint, stale: true } };
}

export function addConstraint(memory: WorkMemory, text: string, scope: Constraint["scope"], currentTurnActive = true): WorkMemory {
  if (!validText(text, 300) || !text.trim()) throw new Error("Enter a constraint of 1–300 characters without terminal controls.");
  if (scope !== "task" && scope !== "turn") throw new Error("Choose this task or this turn for the constraint scope.");
  const normalized = text.trim();
  const pendingTurn = scope === "turn" && !currentTurnActive;
  const existing = memory.constraints.find(item => item.text === normalized && item.scope === scope);
  if (existing) {
    if (Boolean(existing.pendingTurn) === pendingTurn) return memory;
    const { pendingTurn: _previousTiming, ...rest } = existing;
    return { ...memory, revision: nextRevision(memory.revision), constraints: memory.constraints.map(item => item.id === existing.id
      ? { ...rest, createdAt: new Date().toISOString(), ...(pendingTurn ? { pendingTurn: true } : {}) } : item) };
  }
  if (memory.constraints.length >= 12) throw new Error("Pair keeps up to 12 active constraints. Remove one before adding another.");
  return { ...memory, revision: nextRevision(memory.revision), constraints: [...memory.constraints, { id: randomUUID(), text: normalized, scope, createdAt: new Date().toISOString(), ...(pendingTurn ? { pendingTurn: true } : {}) }] };
}

export function removeConstraint(memory: WorkMemory, id: string): WorkMemory {
  const constraints = memory.constraints.filter(item => item.id !== id);
  return constraints.length === memory.constraints.length ? memory : { ...memory, revision: nextRevision(memory.revision), constraints };
}

export function expireTurnConstraints(memory: WorkMemory): WorkMemory {
  if (!memory.constraints.some(item => item.scope === "turn")) return memory;
  const constraints = memory.constraints.flatMap(item => {
    if (item.scope !== "turn") return [item];
    if (!item.pendingTurn) return [];
    const { pendingTurn: _pending, ...active } = item;
    return [active];
  });
  return { ...memory, revision: nextRevision(memory.revision), constraints };
}

/** Stable concise facts for change-triggered context, never UI navigation. */
export function compactMemory(memory: WorkMemory): string {
  const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();
  const checkpoint = memory.checkpoint;
  return [
    ...(checkpoint ? [
      `Checkpoint r${checkpoint.revision} (agent report${checkpoint.stale ? "; later work may make this outdated" : ""}):`,
      ...fields.filter(field => checkpoint[field]).map(field => `- ${field}: ${singleLine(checkpoint[field])}`),
    ] : []),
    ...(memory.constraints.length ? ["Pinned human constraints:", ...memory.constraints.map(item => `- [${item.scope === "task" ? "this task" : item.pendingTurn ? "next turn" : "this turn"}] ${singleLine(item.text)}`)] : []),
  ].join("\n");
}
