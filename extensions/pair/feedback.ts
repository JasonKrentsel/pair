import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BridgeReview } from "./bridge.ts";

export interface FeedbackComment {
  id: string; changeIndex: number; side: "before" | "proposed" | "command";
  startLine: number; endLine: number; intent: "ask" | "revise"; text: string;
}
export interface FeedbackBatch {
  reviewId: string; revision: number; fingerprint: string; batchId: string; comments: FeedbackComment[];
}
export interface FeedbackThread extends FeedbackComment {
  batchId: string; reviewId: string; revision: number; fingerprint: string; label: string;
  snapshotHash: string; excerpt: string; excerptTruncated?: boolean; createdAt: string;
  status: "submitted" | "answered" | "revision-ready" | "addressed" | "outdated";
  latestReviewId?: string; reply?: string;
}
export interface ArchivedReview extends BridgeReview { createdAt: string; revises?: { reviewId: string } }
export interface FeedbackState { version: 1; revision: number; scopeId: string; threads: FeedbackThread[]; reviews: ArchivedReview[] }
export interface FeedbackDecision { batchId: string; reviewId: string; intent: "ask" | "revise"; threads: FeedbackThread[] }
export type ReviewEvent = { version: 1; root: string; scopeId: string } & (
  { kind: "published"; review: ArchivedReview }
  | { kind: "batch"; batchId: string; requestHash: string; threads: FeedbackThread[] }
  | { kind: "outcome"; reviewId: string; status: string }
  | { kind: "thread-state"; threadId: string; status: "addressed" | "open" }
  | { kind: "reply"; replies: { threadId: string; text: string }[] }
  | { kind: "reset" }
);

const MAX_REVIEWS = 8, MAX_THREADS = 80, MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum && !controls.test(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every(key => fields.includes(key));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : record(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

export function parseFeedbackBatch(value: unknown): FeedbackBatch {
  if (!record(value) || !exact(value, ["reviewId", "revision", "fingerprint", "batchId", "comments"]) || !id(value.reviewId) || !id(value.batchId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("Include the exact review identity and a unique feedback batch ID.");
  if (!Array.isArray(value.comments) || !value.comments.length || value.comments.length > 10) throw new Error("Send 1–10 section comments together.");
  const ids = new Set<string>();
  const comments = value.comments.map((item: unknown): FeedbackComment => {
    if (!record(item) || !exact(item, ["id", "changeIndex", "side", "startLine", "endLine", "intent", "text"]) || !id(item.id) || ids.has(item.id)) throw new Error("Each comment needs its own unique ID.");
    if (!Number.isSafeInteger(item.changeIndex) || item.changeIndex < 0 || !["before", "proposed", "command"].includes(item.side)
      || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine || item.endLine - item.startLine >= 40) throw new Error("Select a valid section of up to 40 lines in the displayed change.");
    if (!["ask", "revise"].includes(item.intent) || !text(item.text, 1500)) throw new Error("Use Ask or Request change with a comment of 1–1,500 characters.");
    ids.add(item.id);
    return { id: item.id, changeIndex: item.changeIndex, side: item.side, startLine: item.startLine, endLine: item.endLine, intent: item.intent, text: item.text.trim() };
  });
  return { reviewId: value.reviewId, revision: value.revision, fingerprint: value.fingerprint, batchId: value.batchId, comments };
}

export function parseThreadState(value: unknown): { revision: number; threadId: string; status: "addressed" | "open" } {
  if (!record(value) || !exact(value, ["revision", "threadId", "status"]) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !id(value.threadId) || !["addressed", "open"].includes(value.status)) throw new Error("Include the feedback revision, thread ID, and addressed or open state.");
  return { revision: value.revision, threadId: value.threadId, status: value.status };
}

function validArchive(value: unknown): value is ArchivedReview {
  return record(value) && id(value.id) && Number.isSafeInteger(value.revision) && value.revision >= 1 && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && text(value.title, 140) && text(value.why, 1800) && typeof value.status === "string" && value.status.length <= 300 && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt)) && (!value.revises || record(value.revises) && id(value.revises.reviewId))
    && Array.isArray(value.changes) && value.changes.length > 0 && value.changes.length <= 8 && value.changes.every((change: unknown) => record(change)
      && text(change.label, 4096) && text(change.kind, 100) && ["before", "after", "command"].every(key => change[key] === undefined || typeof change[key] === "string" && Buffer.byteLength(change[key]) <= 256 * 1024));
}

/** Local review history. Events are persisted before becoming visible and never enter model context. */
export class FeedbackStore {
  private root = "";
  private value: FeedbackState = { version: 1, revision: 0, scopeId: randomUUID(), threads: [], reviews: [] };
  private batches = new Map<string, { requestHash: string; threads: FeedbackThread[] }>();
  private emit?: (event: ReviewEvent) => void;

  get state(): FeedbackState { return structuredClone(this.value); }
  get projectRoot(): string { return this.root; }
  setHandler(handler: ((event: ReviewEvent) => void) | undefined): void { this.emit = handler; }
  ensureRoot(root: string): void { if (this.root !== resolve(root)) this.reset(root, false); }
  archived(reviewId: string): ArchivedReview | undefined { const found = this.value.reviews.find(review => review.id === reviewId); return found && structuredClone(found); }

  reset(root = this.root, persist = true): void {
    const nextRoot = root ? resolve(root) : "";
    const event: ReviewEvent = { version: 1, root: nextRoot, scopeId: randomUUID(), kind: "reset" };
    if (persist && nextRoot) this.emit?.(structuredClone(event));
    this.root = nextRoot; this.value = { version: 1, revision: 0, scopeId: event.scopeId, threads: [], reviews: [] }; this.batches.clear();
  }

  private save(event: Omit<ReviewEvent, "version" | "root" | "scopeId">): void {
    if (!this.root) throw new Error("Start a Pair review before changing feedback.");
    const entry = { ...event, version: 1, root: this.root, scopeId: this.value.scopeId } as ReviewEvent;
    this.emit?.(structuredClone(entry));
    this.apply(entry);
  }

  publish(review: BridgeReview, revises?: { reviewId: string }): void {
    if (revises) {
      const base = this.archived(revises.reviewId);
      if (!base || !this.value.threads.some(thread => thread.reviewId === base.id || thread.latestReviewId === base.id)) throw new Error("The feedback proposal is no longer available. Publish a fresh change.");
    }
    const archived: ArchivedReview = { ...structuredClone(review), pending: false, createdAt: new Date().toISOString(), ...(revises ? { revises } : {}) };
    if (!validArchive(archived)) throw new Error("The proposed review cannot be retained for section feedback.");
    this.save({ kind: "published", review: archived } as Omit<ReviewEvent, "version" | "root" | "scopeId">);
  }

  outcome(reviewId: string, status: string): void {
    if (this.value.reviews.find(review => review.id === reviewId)?.status === status || !this.value.reviews.some(review => review.id === reviewId)) return;
    this.save({ kind: "outcome", reviewId, status: status.slice(0, 300) } as Omit<ReviewEvent, "version" | "root" | "scopeId">);
  }

  previousBatch(batch: FeedbackBatch): FeedbackDecision | undefined {
    const previous = this.batches.get(batch.batchId);
    if (!previous) return;
    if (previous.requestHash !== hash(canonical(batch))) throw new Error("That feedback batch ID was already used for different comments.");
    return { batchId: batch.batchId, reviewId: batch.reviewId, intent: previous.threads.some(thread => thread.intent === "ask") ? "ask" : "revise", threads: structuredClone(previous.threads) };
  }

  submit(batch: FeedbackBatch, review: BridgeReview): FeedbackDecision {
    const previous = this.previousBatch(batch);
    if (previous) return previous;
    if (!review.pending || batch.reviewId !== review.id || batch.revision !== review.revision || batch.fingerprint !== review.fingerprint) throw new Error("The proposal changed or was already decided. Refresh before sending feedback.");
    const now = new Date().toISOString();
    const threads = batch.comments.map((comment): FeedbackThread => {
      if (this.value.threads.some(thread => thread.id === comment.id)) throw new Error("That comment ID already belongs to another submission.");
      const change = review.changes[comment.changeIndex];
      const source = change && (comment.side === "before" ? change.before : comment.side === "proposed" ? change.after : change.command);
      if (source === undefined) throw new Error("That comment does not identify a displayed file or command.");
      const lines = source.replace(/\r\n|\r/g, "\n").split("\n");
      if (comment.endLine > lines.length) throw new Error("The selected lines are outside the displayed snapshot.");
      const excerpt = lines.slice(comment.startLine - 1, comment.endLine).join("\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
      return { ...comment, batchId: batch.batchId, reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint,
        label: change.label, snapshotHash: hash(source), excerpt: excerpt.slice(0, 4000), ...(excerpt.length > 4000 ? { excerptTruncated: true } : {}), createdAt: now, status: "submitted" };
    });
    this.save({ kind: "batch", batchId: batch.batchId, requestHash: hash(canonical(batch)), threads } as Omit<ReviewEvent, "version" | "root" | "scopeId">);
    return { batchId: batch.batchId, reviewId: review.id, intent: threads.some(thread => thread.intent === "ask") ? "ask" : "revise", threads: structuredClone(threads) };
  }

  setThreadState(value: ReturnType<typeof parseThreadState>): void {
    if (value.revision !== this.value.revision) throw new Error("Feedback changed. Refresh before updating its state.");
    const thread = this.value.threads.find(item => item.id === value.threadId);
    if (!thread) throw new Error("This feedback thread is no longer available.");
    if ((value.status === "addressed") === (thread.status === "addressed")) return;
    this.save({ kind: "thread-state", threadId: value.threadId, status: value.status } as Omit<ReviewEvent, "version" | "root" | "scopeId">);
  }

  reply(replies: { threadId: string; text: string }[]): void {
    if (!Array.isArray(replies) || !replies.length || replies.length > 8) throw new Error("Reply to 1–8 feedback threads at once.");
    const seen = new Set<string>();
    const clean = replies.map(reply => {
      if (!record(reply) || !exact(reply, ["threadId", "text"]) || !id(reply.threadId) || seen.has(reply.threadId) || !text(reply.text, 1200)) throw new Error("Each reply needs a unique thread ID and 1–1,200 characters.");
      seen.add(reply.threadId);
      const thread = this.value.threads.find(item => item.id === reply.threadId);
      if (!thread || ["addressed", "outdated"].includes(thread.status)) throw new Error("Reply to an unresolved thread in the current Pair review history.");
      return { threadId: reply.threadId, text: reply.text.trim() };
    }).filter(reply => this.value.threads.find(thread => thread.id === reply.threadId)?.reply !== reply.text);
    if (clean.length) this.save({ kind: "reply", replies: clean } as Omit<ReviewEvent, "version" | "root" | "scopeId">);
  }

  restore(events: unknown[], root = this.root): void {
    this.reset(root, false);
    for (const event of events) {
      if (!record(event) || event.version !== 1 || event.root !== this.root || !id(event.scopeId)) continue;
      if (event.kind === "reset") { this.value = { version: 1, revision: 0, scopeId: event.scopeId, threads: [], reviews: [] }; this.batches.clear(); continue; }
      if (event.kind === "published" && validArchive(event.review)) {
        if (event.scopeId !== this.value.scopeId) { this.value = { version: 1, revision: 0, scopeId: event.scopeId, threads: [], reviews: [] }; this.batches.clear(); }
        this.apply(event as ReviewEvent);
      } else if (event.scopeId === this.value.scopeId) {
        if (event.kind === "outcome" && id(event.reviewId) && text(event.status, 300)
          || event.kind === "thread-state" && id(event.threadId) && ["addressed", "open"].includes(event.status)
          || event.kind === "reply" && Array.isArray(event.replies) && event.replies.length <= 8 && event.replies.every((r: unknown) => record(r) && id(r.threadId) && text(r.text, 1200))) this.apply(event as ReviewEvent);
        else if (event.kind === "batch" && id(event.batchId) && /^[a-f0-9]{64}$/.test(event.requestHash) && Array.isArray(event.threads) && event.threads.length > 0 && event.threads.length <= 10) {
          // Reconstruct and validate anchors against the saved exact proposal instead of trusting persisted excerpts.
          try {
            const first = event.threads[0];
            const review = this.archived(first.reviewId);
            const batch = parseFeedbackBatch({ reviewId: first.reviewId, revision: first.revision, fingerprint: first.fingerprint, batchId: event.batchId,
              comments: event.threads.map((t: FeedbackThread) => ({ id: t.id, changeIndex: t.changeIndex, side: t.side, startLine: t.startLine, endLine: t.endLine, intent: t.intent, text: t.text })) });
            if (!review || event.requestHash !== hash(canonical(batch)) || event.threads.some((t: FeedbackThread) => t.reviewId !== review.id || t.fingerprint !== review.fingerprint || typeof t.excerpt !== "string" || t.excerpt.length > 4000 || !Number.isFinite(Date.parse(t.createdAt)))) continue;
            const handler = this.emit; this.emit = undefined;
            try {
              this.submit(batch, { ...review, pending: true });
              for (const saved of event.threads as FeedbackThread[]) {
                const thread = this.value.threads.find(item => item.id === saved.id);
                const duplicate = this.batches.get(batch.batchId)?.threads.find(item => item.id === saved.id);
                if (thread) thread.createdAt = saved.createdAt;
                if (duplicate) duplicate.createdAt = saved.createdAt;
              }
            } finally { this.emit = handler; }
          } catch { /* Malformed history never creates a comment or permission. */ }
        }
      }
    }
  }

  private openStatus(thread: FeedbackThread): FeedbackThread["status"] {
    const original = this.value.reviews.find(review => review.id === thread.reviewId)?.changes[thread.changeIndex];
    if (!original) return "outdated";
    if (thread.latestReviewId) {
      const replacement = this.value.reviews.find(review => review.id === thread.latestReviewId)?.changes.find(change => change.label === thread.label);
      if (!replacement) return "outdated";
      const changed = original.before !== replacement.before || original.after !== replacement.after || original.command !== replacement.command;
      if (changed) return thread.intent === "revise" ? "revision-ready" : "outdated";
    }
    return thread.reply ? "answered" : "submitted";
  }

  private apply(event: ReviewEvent): void {
    if (event.kind === "published") {
      if (!this.value.reviews.some(review => review.id === event.review.id)) this.value.reviews.push(structuredClone(event.review));
      if (event.review.revises) for (const thread of this.value.threads) {
        if (thread.status === "addressed") continue;
        if (thread.reviewId !== event.review.revises.reviewId && thread.latestReviewId !== event.review.revises.reviewId) continue;
        thread.latestReviewId = event.review.id;
        thread.status = this.openStatus(thread);
      }
    } else if (event.kind === "batch") {
      if (this.batches.has(event.batchId)) return;
      this.batches.set(event.batchId, { requestHash: event.requestHash, threads: structuredClone(event.threads) });
      this.value.threads.push(...structuredClone(event.threads));
      const review = this.value.reviews.find(review => review.id === event.threads[0]?.reviewId);
      if (review) review.status = "Feedback submitted";
    } else if (event.kind === "outcome") {
      const review = this.value.reviews.find(review => review.id === event.reviewId);
      if (review) { review.status = event.status; review.pending = false; }
    } else if (event.kind === "thread-state") {
      const thread = this.value.threads.find(thread => thread.id === event.threadId);
      if (thread) thread.status = event.status === "addressed" ? "addressed" : this.openStatus(thread);
    } else if (event.kind === "reply") {
      for (const reply of event.replies) {
        const thread = this.value.threads.find(thread => thread.id === reply.threadId);
        if (thread && !["addressed", "outdated"].includes(thread.status)) { thread.reply = reply.text; if (thread.status === "submitted") thread.status = "answered"; }
      }
    }
    while (this.value.reviews.length > MAX_REVIEWS || Buffer.byteLength(JSON.stringify(this.value.reviews)) > MAX_SNAPSHOT_BYTES) this.value.reviews.shift();
    if (this.value.threads.length > MAX_THREADS) this.value.threads.splice(0, this.value.threads.length - MAX_THREADS);
    for (const thread of this.value.threads) if (thread.status !== "addressed" && !this.value.reviews.some(review => review.id === thread.reviewId)) thread.status = "outdated";
    while (this.batches.size > 80) this.batches.delete(this.batches.keys().next().value!);
    this.value.revision++;
  }
}
