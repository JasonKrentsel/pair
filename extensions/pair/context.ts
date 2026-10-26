import type { PairState } from "./state.ts";
import { compactMemory, normalizeMemory } from "./checkpoint.ts";

/** Stable guidance: UI state and renderer interactions never modify this prefix. */
export const PAIR_CONTRACT = `Pair permissions are enabled.
Investigate with read/grep/find/ls. Use pair_step for one coherent change: title, concise Markdown rationale, and related edits/writes to up to four files or one standalone command. Prefer localized edits. Add per-file why or line annotations only where useful. Supported routine Git inspection/setup runs directly. Design is optional and grants no execution permission.
Honor chat design approval without asking again or republishing identical text. For approved specific changes, publish once and use pair_work approve_design for that revision.
Approval covers only the displayed group. Deny stops mutations. Interpret notes: revise needs fresh approval; skip omits the action; explain means discuss first. Section questions use pair_work feedback replies, then stop for the human. For requested corrections, use pair_step revises with only replacement files; retained files still require fresh review. Never repeat rejected work or bypass the guard. Preserve partial work; repairs need fresh permission.
Put explanations in the review; its card reports ordinary success. Give brief progress updates when needed. At milestones update pair_work checkpoint: implemented, verified, usable, deferred, next. Internal tests do not imply usable integration. Honor human constraints and chat limits; neither grants execution permission. Run purposeful checks; repeat or broaden only for new changes, failures, or a human request. See pair-implementation.`;

export function conciseState(state: PairState): string {
  return [
    "Pair: step permissions enabled.",
    state.goal ? `Goal: ${state.goal}` : "",
    state.design.path ? `Design: ${state.design.path} (revision ${state.design.revision}, approved ${state.design.approvedRevision ?? "none"}).` : "Design: optional, none saved.",
    !state.memory?.checkpoint && state.increment ? `Saved review: ${state.increment.title}; reference only, no execution grant.` : "",
    !state.memory?.checkpoint && state.pauseReason ? `Saved review note: ${state.pauseReason}` : "",
    state.memory ? compactMemory(normalizeMemory(state.memory)) : "",
  ].filter(Boolean).join("\n");
}

/** Model-facing tool receipts contain the outcome and current facts, not the rules. */
export function pairWorkResult(state: PairState, action: "status" | "revise" | "design" | "approve_design" | "checkpoint", target?: "design" | "increment"): string {
  const brief = (value: string, limit = 180) => {
    const line = value.replace(/\s+/g, " ").trim();
    return line.length <= limit ? line : line.slice(0, limit - 1) + "…";
  };
  const approval = state.design.approvedRevision === state.design.revision ? "approved"
    : state.phase === "design-approval" ? "awaiting approval" : "draft";
  const design = state.design.path
    ? `Design: ${state.design.path} · revision ${state.design.revision} · ${approval}.`
    : "Design: none saved.";
  if (action === "design") return `Design published.\n${design}`;
  if (action === "checkpoint") return `Checkpoint ${state.memory?.checkpoint?.revision ?? 0} saved. Human constraints unchanged.`;
  if (action === "approve_design") return `Design approval recorded.\n${design}`;
  if (action === "revise") {
    return target === "increment"
      ? `Saved review reopened; approval cleared.\nReview: ${brief(state.increment?.title ?? "Earlier review")}.`
      : `Design reopened; approval cleared.\n${design}`;
  }
  return [
    `Pair: ${state.active ? "on" : "off"}.`,
    state.goal ? `Goal: ${brief(state.goal)}` : "",
    design,
    state.increment ? `Saved review: ${brief(state.increment.title)} (reference only).` : "",
    state.pauseReason ? `Saved review note: ${brief(state.pauseReason, 240)}` : "",
    state.memory ? compactMemory(normalizeMemory(state.memory)) : "",
  ].filter(Boolean).join("\n");
}

export function withPairContract(systemPrompt: string): string {
  return systemPrompt.includes(PAIR_CONTRACT) ? systemPrompt : `${systemPrompt}\n\n${PAIR_CONTRACT}`;
}

export function normalizeStepArguments(args: unknown): any {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const value = args as Record<string, unknown>;
  if ("change" in value && "changes" in value) throw new Error("Supply changes or the legacy single change, not both.");
  if (!("change" in value)) return args;
  const { change, ...rest } = value;
  return { ...rest, changes: [change] };
}
