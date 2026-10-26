import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ActionReplyDetails, ActionReplyPart, ActionToolStatus } from "./action-session.ts";

const DISPLAY_TEXT = 32000;
const DISPLAY_RESULT = 8000;
const clip = (text: string, limit: number) => text.length > limit ? text.slice(0, limit) + "\n[Display truncated]" : text;
const contentText = (value: unknown): string => {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
  return value.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
};

/** Project SDK events into a bounded, ordered UI transcript. Never fed back to the model. */
export class ActionActivity {
  private rounds: { message: AssistantMessage; complete: boolean }[] = [];
  private outcomes = new Map<string, { status: ActionToolStatus; result?: string; error?: string }>();
  private executed = new Set<string>();
  private finalText?: string;
  private readonly readable: (raw: string) => string | undefined;
  private readonly allowed: ReadonlySet<string>;

  constructor(readable: (raw: string) => string | undefined, allowed: ReadonlySet<string>) {
    this.readable = readable;
    this.allowed = allowed;
  }

  private toolKey(id: string) { return `${this.rounds.length - 1}:tool:${id}`; }
  markExecuted(id: string) { this.executed.add(this.toolKey(id)); }
  markBlocked(id: string, reason: string) { this.outcomes.set(this.toolKey(id), { status: "not-run", error: reason }); }
  acceptFinalText(text: string) { this.finalText = text; }

  update(event: AgentEvent) {
    if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
      if (event.type === "message_start") this.rounds.push({ message: event.message, complete: false });
      else {
        const round = this.rounds.at(-1);
        if (round) { round.message = event.message; round.complete = event.type === "message_end"; }
      }
    }
    if (event.type === "tool_execution_start" && !this.outcomes.has(this.toolKey(event.toolCallId)))
      this.outcomes.set(this.toolKey(event.toolCallId), { status: this.allowed.has(event.toolName) ? "running" : "not-run" });
    if (event.type === "tool_execution_update") {
      const prior = this.outcomes.get(this.toolKey(event.toolCallId));
      if (prior?.status === "running") prior.result = clip(contentText(event.partialResult), DISPLAY_RESULT);
    }
    if (event.type === "tool_execution_end") {
      const result = clip(contentText(event.result), DISPLAY_RESULT);
      const status = this.executed.has(this.toolKey(event.toolCallId)) ? event.isError ? "failed" : "completed" : "not-run";
      const prior = this.outcomes.get(this.toolKey(event.toolCallId));
      this.outcomes.set(this.toolKey(event.toolCallId), { status, result, ...(event.isError ? { error: prior?.error || result || "The read tool failed." } : {}) });
    }
  }

  get finalMessage() { return this.rounds.at(-1)?.message; }
  get modelRounds() { return this.rounds.length; }

  snapshot(): ActionReplyDetails {
    const parts: ActionReplyPart[] = [];
    const usage: NonNullable<ActionReplyDetails["usage"]> = {};
    let remainingReasoning = DISPLAY_TEXT;
    // Keep the accepted final answer visible even when earlier investigation
    // commentary consumed the display budget.
    let remainingText = DISPLAY_TEXT - Math.min(DISPLAY_TEXT, this.finalText?.length ?? 0);
    for (const [roundIndex, { message, complete }] of this.rounds.entries()) {
      if (roundIndex === this.rounds.length - 1 && this.finalText !== undefined) remainingText = DISPLAY_TEXT;
      const raw = message.content.filter(part => part.type === "text").map(part => part.text).join("");
      const readable = roundIndex === this.rounds.length - 1 && this.finalText !== undefined ? this.finalText : this.readable(raw);
      const prefix = readable !== undefined && raw.startsWith(readable);
      let textOffset = 0, decodedEmitted = false;
      for (const [contentIndex, part] of message.content.entries()) {
        if (parts.length >= 128) break;
        const id = `${roundIndex}:${contentIndex}`;
        if (part.type === "text") {
          const text = readable === undefined ? "" : prefix ? part.text.slice(0, Math.max(0, readable.length - textOffset)) : decodedEmitted ? "" : readable;
          textOffset += part.text.length;
          decodedEmitted = true;
          if (text && remainingText > 0) {
            parts.push({ type: "text", id, text: clip(text, remainingText) });
            remainingText = Math.max(0, remainingText - text.length);
          }
        } else if (part.type === "thinking") {
          if (part.redacted) parts.push({ type: "reasoning", id, text: "", redacted: true });
          else if (part.thinking && remainingReasoning > 0) {
            parts.push({ type: "reasoning", id, text: clip(part.thinking, remainingReasoning) });
            remainingReasoning = Math.max(0, remainingReasoning - part.thinking.length);
          }
        } else if (part.type === "toolCall") {
          const id = `${roundIndex}:${contentIndex}:tool`;
          const outcome = this.outcomes.get(`${roundIndex}:tool:${part.id}`);
          parts.push({ type: "tool", id, name: part.name.slice(0, 160), arguments: clip(part.argumentsError || JSON.stringify(part.arguments, null, 2), DISPLAY_RESULT), status: outcome?.status ?? "not-run", ...(outcome?.result ? { result: outcome.result } : {}), ...(outcome?.error ? { error: outcome.error } : {}) });
        }
      }
      if (complete) for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
        const value = message.usage?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = (usage[key] ?? 0) + value;
      }
    }
    return {
      parts,
      reasoning: parts.flatMap(part => part.type === "reasoning" && !part.redacted ? [part.text] : []).join("\n\n"),
      reasoningRedacted: parts.some(part => part.type === "reasoning" && part.redacted),
      toolCalls: parts.filter(part => part.type === "tool").map(part => ({ id: part.id, name: part.name, arguments: part.arguments, status: part.status, ...(part.result ? { result: part.result } : {}), ...(part.error ? { error: part.error } : {}) })),
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}
