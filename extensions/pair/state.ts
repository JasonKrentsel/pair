import type { WorkMemory } from "./checkpoint.ts";
export type Phase = "design" | "design-approval" | "proposal" | "increment-approval" | "implement" | "review" | "paused";

export interface FileSnapshot {
  exists: boolean;
  hash: string;
  text?: string;
}

export interface Design {
  path: string;
  text: string;
  revision: number;
  approvedRevision?: number;
}

export interface Increment {
  id: string;
  revision: number;
  title: string;
  behavior: string;
  approach: string;
  files: string[];
  /** Human-facing paths; directories are expanded into the concrete files above. */
  requestedFiles?: string[];
  operations?: FileOperation[];
  verification: string;
  commands: { tool: "bash" | "powershell"; command: string }[];
  approvedRevision?: number;
  // Preserve the original baseline when a partially implemented proposal expands.
  baseline: Record<string, FileSnapshot>;
  expected: Record<string, string>;
  summary?: string;
  checks?: string;
  deviations?: string;
}

export interface FileOperation {
  kind: "move" | "copy";
  from: string;
  to: string;
  /** Frozen source membership, expanded before the proposal is approved. */
  sourceFiles: string[];
  completed?: boolean;
}

export interface PairState {
  version: 1;
  root: string;
  active: boolean;
  goal: string;
  phase: Phase;
  design: Design;
  increment?: Increment;
  pauseReason?: string;
  progress: string[];
  memory?: WorkMemory;
}

export const STATE_ENTRY = "pair-state-v1";
export const phaseLabels: Record<Phase, string> = {
  design: "Design discussion",
  "design-approval": "Awaiting design approval",
  proposal: "Ready for a proposal",
  "increment-approval": "Awaiting increment approval",
  implement: "Implementing approved scope",
  review: "Ready for review",
  paused: "Paused",
};

export function reopenDesign(state: PairState, text: string): PairState {
  const previous = state.phase === "proposal" && state.increment?.summary ? undefined : state.increment;
  return {
    ...state, phase: "design", pauseReason: undefined,
    design: { ...state.design, text, approvedRevision: undefined },
    increment: previous ? {
      ...previous, approvedRevision: undefined, summary: undefined, checks: undefined, deviations: undefined,
    } : undefined,
  };
}

