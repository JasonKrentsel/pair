import { randomUUID } from "node:crypto";
import { diffLines } from "diff";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeReview, PairReviewBridge } from "./bridge.ts";
import type { PreparedChange } from "./changes.ts";
import type { ChangePreview } from "./review-model.ts";
import { createActionSession, type ActionSession, type ActionReplyDetails } from "./action-session.ts";
import { buildActionRevision } from "./action-revisions.ts";

export interface ActionConversation {
  id: string; reviewId: string; revision: number; fingerprint: string; gate?: number;
  index: number; startLine?: number; endLine?: number;
  status: "idle" | "running" | "ready" | "error" | "closed";
  messages: ({ id?: string; requestId?: string; role: "user" | "assistant"; text: string; error?: string; stopped?: boolean } & ActionReplyDetails)[];
  candidate?: { id: string; summary: string; added: number; removed: number; original: ChangePreview; preview: ChangePreview };
  error?: string;
}
type Record = { requests?: Map<string,{text:string;mode:string}>; view: ActionConversation; session?: ActionSession; abort?: AbortController; request?: { id: string; text: string; mode: string }; content?: string; candidatePrepared?: PreparedChange[] };
export type ActionSessionFactory = typeof createActionSession;

// Keep sibling protocol/context available once without duplicating selected source.
// Limit the serialized UTF-8 payload, including JSON escapes, to 30 KiB.
function otherActionContext(review: BridgeReview, selected: number): string {
  const limit = (text: string, chars: number) => text.length <= chars ? text
    : text.slice(0, Math.floor(chars / 2)) + "\n[Context omitted for size; ask if needed.]\n" + text.slice(-Math.floor(chars / 2));
  const siblings = review.changes.flatMap((change, index) => index === selected ? [] : [{
    action: index + 1, label: limit(change.label, 300), kind: change.kind,
    rationale: limit(change.why ?? "", 700), proposed: change.after ?? change.command ?? "",
  }]);
  if (!siblings.length) return "";
  let budget = 12000;
  for (;;) {
    const result = JSON.stringify(siblings.map(action => ({ ...action, proposed: limit(action.proposed, budget) })));
    if (Buffer.byteLength(result, "utf8") <= 30 * 1024) return result;
    budget = Math.floor(budget / 2);
    if (budget < 64) return "Other pending actions omitted for size. Ask the human if their protocol is needed.";
  }
}

/** Ephemeral action forks. Nothing here writes a project file or advances the parent. */
export class ActionConversations {
  private readonly threads = new Map<string, Record>();
  private closed = false;
  private options: {
    bridge: PairReviewBridge; ctx: ExtensionContext; root: string; toolCallId: string;
    getPrepared: () => PreparedChange[];
    adopt: (prepared: PreparedChange[], index: number, summary: string) => void;
    factory?: ActionSessionFactory;
  };
  constructor(options: ActionConversations["options"]) { this.options = options; }
  snapshot() { return [...this.threads.values()].map(({ view }) => structuredClone(view)); }
  get available() { return !!(this.options.factory || this.options.ctx.model && this.options.ctx.modelRegistry?.streamSimple); }
  private touch() { this.options.bridge.touchConversations(); }
  private current(body: any): BridgeReview {
    const review = this.options.bridge.current;
    if (this.closed || !review?.pending || body.reviewId !== review.id || body.revision !== review.revision || body.fingerprint !== review.fingerprint || (body.gate ?? 1) !== (review.gate ?? 1))
      throw new Error("The step changed or finished. Open its current action to continue.");
    return review;
  }
  async handle(body: any): Promise<unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Choose an action conversation.");
    const review = this.current(body);
    if (!this.available) throw new Error("Select a model in Pi before asking about this action.");
    if (body.action === "open") {
      if (!Number.isInteger(body.index) || body.index < 0 || body.index >= review.changes.length) throw new Error("Select one action in this step.");
      const change = review.changes[body.index];
      const source = change.after ?? change.command;
      if (source === undefined) throw new Error("This action has no editable proposal.");
      const scope = body.startLine !== undefined || body.endLine !== undefined;
      if (scope && (!Number.isInteger(body.startLine) || !Number.isInteger(body.endLine) || body.startLine < 1 || body.endLine < body.startLine || body.endLine > source.split(/\r\n|\r|\n/).length)) throw new Error("Select existing proposed lines.");
      const found = [...this.threads.values()].find(({view}) => view.revision === review.revision && view.index === body.index && view.startLine === body.startLine && view.endLine === body.endLine && view.status !== "closed");
      if (found) return { conversationId: found.view.id };
      if (this.threads.size >= 12) throw new Error("This step has reached its conversation limit. Finish the step or request a new proposal.");
      const view: ActionConversation = { id: randomUUID(), reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, gate: review.gate, index: body.index,
        ...(scope ? { startLine: body.startLine, endLine: body.endLine } : {}), status: "idle", messages: [] };
      this.threads.set(view.id, {view}); this.touch(); return { conversationId: view.id };
    }
    const record = this.threads.get(body.conversationId);
    if (!record || record.view.revision !== review.revision || record.view.index !== body.index || record.view.status === "closed") throw new Error("Open a conversation for the current action.");
    const view = record.view;
    if (body.action === "stop") { record.abort?.abort(); return { ok: true }; }
    if (body.action === "discard") {
      if (view.status === "running") throw new Error("Stop the reply before discarding its revision.");
      view.candidate = undefined; record.content = undefined; record.candidatePrepared = undefined; this.touch(); return {ok:true};
    }
    if (body.action === "adopt") {
      if (view.status === "running" || !view.candidate || body.candidateId !== view.candidate.id || !record.candidatePrepared) throw new Error("Inspect the current suggested revision before using it.");
      // Rebuild against the original frozen baselines, never the newly-read disk.
      const next = await buildActionRevision(this.options.root, this.options.getPrepared(), view.index, record.content!, view.candidate.summary, view.startLine ? {startLine:view.startLine,endLine:view.endLine!} : undefined);
      this.current(body);
      const summary = view.candidate.summary;
      const updated = this.options.bridge.revisePending(body, next.map(change => change.preview), () => this.options.adopt(next, view.index, summary));
      for (const item of this.threads.values()) { item.abort?.abort(); item.session?.dispose(); item.view.status = "closed"; item.view.candidate = undefined; item.candidatePrepared = undefined; item.content = undefined; }
      this.touch(); return { adopted: true, review: updated };
    }
    if (body.action !== "send") throw new Error("Unknown action conversation request.");
    if (typeof body.requestId !== "string" || body.requestId.length > 100 || !body.requestId) throw new Error("Include a message request ID.");
    const mode = body.mode ?? "chat";
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 3000 || !["chat", "ask", "adjust"].includes(mode)) throw new Error("Send a message about this action in up to 3,000 characters.");
    const duplicate = record.requests?.get(body.requestId);
    if (duplicate) {
      if (duplicate.text !== body.text || duplicate.mode !== mode) throw new Error("That message ID was used for different text.");
      return { accepted: true, conversationId: view.id };
    }
    if (view.status === "running") throw new Error("Wait for the current reply, or stop it first.");
    if (body.retryMessageId !== undefined) {
      const last = view.messages.at(-1), prompt = view.messages.at(-2);
      if (typeof body.retryMessageId !== "string" || !last || last.id !== body.retryMessageId || !last.error || prompt?.role !== "user" || prompt.text !== body.text.trim())
        throw new Error("Only the latest failed reply can be retried. Send a new message to continue.");
    }
    if (view.messages.filter(message => message.role === "assistant" && !message.error && !message.stopped).length >= 8) throw new Error("This focused conversation has reached eight turns. Request a new step to continue.");
    if ((record.requests?.size ?? 0) >= 64) throw new Error("This chat has reached its retry limit. Open a new conversation to continue.");
    const change = review.changes[view.index];
    // Opening/reopening Chat stores only UI metadata. Capture the parent branch,
    // prompt and current model exactly once, after the first valid Send.
    record.session ??= (this.options.factory ?? createActionSession)(this.options.ctx, this.options.toolCallId, {
      index: view.index, label: change.label, kind: change.kind, before: change.before, proposed: change.after ?? change.command!,
      startLine: view.startLine, endLine: view.endLine, why: change.why, stepTitle: review.title, stepContext: otherActionContext(review, view.index),
    });
    record.request = { id: body.requestId, text: body.text, mode };
    (record.requests ??= new Map()).set(body.requestId,{text:body.text,mode});
    const abort = new AbortController(); record.abort = abort;
    view.status = "running"; view.error = undefined;
    if (mode === "adjust") { view.candidate = undefined; record.candidatePrepared = undefined; record.content = undefined; }
    if (body.retryMessageId !== undefined) view.messages.splice(-2);
    view.messages.push({id:randomUUID(),role:"user",text:body.text.trim()},{id:randomUUID(),requestId:body.requestId,role:"assistant",text:""});
    const reply = view.messages.at(-1)!;
    this.touch();
    void (async () => {
      try {
        const result = await record.session!.ask(body.text.trim(), { mode: mode === "chat" ? "chat" : mode === "ask" ? "question" : "revise", signal: abort.signal,
          onUpdate: text => { if (!abort.signal.aborted && !this.closed && record.abort === abort) { reply.text = text.slice(0,24000); this.touch(); } },
          onDetails: details => { if (!abort.signal.aborted && !this.closed && record.abort === abort) { Object.assign(reply, details); this.touch(); } } });
        this.current(body); abort.signal.throwIfAborted();
        reply.text = result.text.slice(0,24000);
        if (result.candidate && mode !== "ask") {
          const summary = result.candidate.summary.trim().slice(0,1600);
          const next = await buildActionRevision(this.options.root, this.options.getPrepared(), view.index, result.candidate.content, summary, view.startLine ? {startLine:view.startLine,endLine:view.endLine!} : undefined, abort.signal);
          this.current(body); abort.signal.throwIfAborted();
          record.content = result.candidate.content; record.candidatePrepared = next;
          const preview = next[view.index].preview;
          const delta = diffLines(change.after ?? change.command ?? "", preview.after ?? preview.command ?? "");
          // Candidate stats describe the comparison being inspected, not the
          // complete step's original disk-to-proposal changes.
          const added = delta.reduce((sum, part) => sum + (part.added ? part.count ?? 0 : 0), 0);
          const removed = delta.reduce((sum, part) => sum + (part.removed ? part.count ?? 0 : 0), 0);
          view.candidate = {id:randomUUID(),summary,original:structuredClone(change),preview:structuredClone(preview),added,removed};
        }
        view.status = "ready";
      } catch (error) {
        if (this.closed || view.status === "closed") return;
        view.status = abort.signal.aborted ? "ready" : "error";
        // A stopped stream may suppress late SDK tool-end events. Settle the
        // presentation state here instead of leaving a read spinning forever.
        const unfinished = abort.signal.aborted ? "Read stopped before completing." : "Read did not complete.";
        reply.parts = reply.parts?.map(part => part.type === "tool" && part.status === "running" ? { ...part, status: "failed", error: unfinished } : part);
        reply.toolCalls = reply.toolCalls?.map(call => call.status === "running" ? { ...call, status: "failed", error: unfinished } : call);
        if (abort.signal.aborted) { reply.stopped = true; if (!reply.text) reply.text = "Reply stopped. The proposed step is unchanged."; }
        else { reply.error = String(error instanceof Error ? error.message : error).slice(0,700); view.error = reply.error; }
      } finally { if (record.abort === abort) record.abort = undefined; this.touch(); }
    })();
    return {accepted:true,conversationId:view.id};
  }
  close() {
    this.closed = true;
    for (const item of this.threads.values()) { item.abort?.abort(); item.session?.dispose(); item.view.status = "closed"; item.view.candidate = undefined; item.candidatePrepared = undefined; item.content = undefined; }
    this.touch();
  }
}
