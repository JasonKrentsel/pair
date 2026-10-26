import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { outputTail, type CommandProgress } from "./command-output.ts";
import type { ChangePreview } from "./review-model.ts";
export interface BridgeDecision { action: "approve" | "deny"; note?: string }
export interface BridgeReview {
  id: string;
  revision: number;
  fingerprint: string;
  /** Decision epoch protects late interface responses. */
  gate?: number;
  title: string;
  why: string;
  status: string;
  pending: boolean;
  changes: ChangePreview[];
}
export interface BridgeRegistry {
  version: 1;
  sessionId: string;
  root: string;
  port: number;
  token: string;
  pid: number;
  focusRequestedAt?: number;
}

const MAX_BODY = 16 * 1024;
const MAX_NOTE = 4000;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function decisionFrom(value: unknown): BridgeDecision {
  if (!value || typeof value !== "object") throw new Error("Choose approve or deny.");
  const body = value as Record<string, unknown>;
  if (body.action !== "approve" && body.action !== "deny") throw new Error("Choose approve or deny.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) throw new Error("Notes must be text of at most 4000 characters.");
  if (body.action === "approve" && body.note !== undefined) throw new Error("Use deny with note to request a revision.");
  return { action: body.action, ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}) };
}

/** Local transport only. The existing Pi permission gate still owns execution. */
export class PairReviewBridge {
  private readonly registryDir: string;
  private server?: Server;
  private registry?: BridgeRegistry;
  private registryPath?: string;
  private review?: BridgeReview;
  private focus?: { id: string; selected: number };
  private onDecision?: (decision: BridgeDecision) => void;
  private validate?: () => void;
  private sequence = 0;
  private commandProgress: CommandProgress[] = [];
  private terminal?: { reviewId:string; index:number; runId:string; cols:number; rows:number };
  private terminalHandlers?: { input:(text:string)=>void; resize:(cols:number,rows:number)=>void; stop:()=>void };
  private inputSequence=0;
  private companionSeen=0;
  get companionConnected(){return Date.now()-this.companionSeen<10000;}
  get terminalState(){return this.terminal && {...this.terminal,inputSequence:this.inputSequence};}
  beginTerminal(value: NonNullable<PairReviewBridge["terminal"]>, handlers: NonNullable<PairReviewBridge["terminalHandlers"]>){
    if(this.review?.id!==value.reviewId || this.review.pending)throw new Error("Terminal approval expired.");
    this.terminalHandlers?.stop();this.terminal=value;this.terminalHandlers=handlers;this.inputSequence=0;this.sequence++;
  }
  endTerminal(runId:string){if(this.terminal?.runId===runId){this.terminal=undefined;this.terminalHandlers=undefined;this.sequence++;}}
  terminalAction(body:unknown){
    if(!body || typeof body!=="object")throw new Error("Choose a current terminal action.");
    const b=body as Record<string,unknown>, t=this.terminal, h=this.terminalHandlers;
    if(!t||!h||b.runId!==t.runId||b.reviewId!==t.reviewId||b.index!==t.index||this.review?.id!==t.reviewId)throw new Error("That terminal is no longer running.");
    if(b.action==="input"){
      if(typeof b.text!=="string"||b.text.length>4096||b.sequence!==this.inputSequence+1)throw new Error("Terminal input is stale or too large. Reopen the command.");
      this.inputSequence++;h.input(b.text);
    }else if(b.action==="resize"){
      if(!Number.isInteger(b.cols)||!Number.isInteger(b.rows)||(b.cols as number)<20||(b.cols as number)>400||(b.rows as number)<5||(b.rows as number)>150)throw new Error("Invalid terminal size.");
      t.cols=b.cols as number;t.rows=b.rows as number;h.resize(t.cols,t.rows);
    }else if(b.action==="stop")h.stop();else throw new Error("Unknown terminal action.");
  }
  private gate = 0;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(options: { registryDir?: string } = {}) {
    this.registryDir = options.registryDir ?? process.env.PI_PAIR_BRIDGE_DIR ?? join(homedir(), ".pi", "agent", "pair-bridge");
  }

  get current(): BridgeReview | undefined { return this.review && structuredClone(this.review); }
  get progress(): CommandProgress[] { return structuredClone(this.commandProgress); }
  setCommandProgress(reviewId: string, index: number, status: CommandProgress["status"], text: string): void {
    if (this.review?.id !== reviewId || this.review.pending || !this.review.changes[index]?.command) return;
    const next = { reviewId, index, status, ...outputTail(text) };
    const previous = this.commandProgress.find(item => item.index === index);
    if (previous?.status === status && previous.text === next.text && previous.truncated === next.truncated && previous.raw === next.raw) return;
    this.commandProgress = [...this.commandProgress.filter(item => item.index !== index), next].sort((a, b) => a.index - b.index);
    // Ephemeral output must not revise approved snapshots.
    this.sequence++;
  }
  get decisionVersion(): number { return this.gate; }
  get sessionId(): string | undefined { return this.registry?.sessionId; }
  start(root: string): Promise<void> {
    const absolute = resolve(root);
    const operation = this.lifecycle.then(async () => {
      if (this.server && this.registry?.root === absolute) return;
      await this.stop();
      await this.listen(absolute);
    });
    this.lifecycle = operation.catch(() => {});
    return operation;
  }

  private async listen(root: string): Promise<void> {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.on("clientError", (_error, socket) => socket.destroy());
    this.server = server;
    try {
      await new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
      });
      // The bridge must not prevent Pi from exiting after the terminal closes.
      server.unref();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Pair could not start its local review connection.");
      const registry: BridgeRegistry = { version: 1, sessionId, root, port: address.port, token, pid: process.pid };
      mkdirSync(this.registryDir, { recursive: true, mode: 0o700 });
      const path = join(this.registryDir, sessionId + ".json");
      writeFileSync(path, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
      this.registryPath = path;
      // Windows uses the user's profile ACL; POSIX also gets explicit user-only mode.
      if (process.platform !== "win32") chmodSync(path, 0o600);
      this.registry = registry;
      this.sequence++;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  publish(input: { title: string; why: string; changes: ChangePreview[] }, onDecision: (decision: BridgeDecision) => void, validate?: () => void): BridgeReview {
    if (!this.registry) throw new Error("Start the Pair review connection before publishing.");
    const snapshots = structuredClone(input);
    const id = randomUUID();
    const revision = 1;
    const fingerprint = createHash("sha256").update(JSON.stringify({ id, revision, ...snapshots })).digest("hex");
    const next = { id, revision, fingerprint, gate: 1, ...snapshots, pending: true, status: "Awaiting permission" };
    this.cancel();
    this.gate++;
    this.review = freeze(next);
    this.focus = undefined;
    this.onDecision = onDecision;
    this.validate = validate;
    this.sequence++;
    return this.current!;
  }

  /** Route a user-requested reveal to this session without granting permission. */
  requestFocus(selected = 0): void {
    if (!this.registry || !this.registryPath) throw new Error("Start the Pair review connection before opening it.");
    const registry = { ...this.registry, focusRequestedAt: Math.max(Date.now(), (this.registry.focusRequestedAt ?? 0) + 1) };
    const temporary = this.registryPath + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, this.registryPath);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.registry = registry;
    this.focus = { id: randomUUID(), selected: Number.isSafeInteger(selected) ? Math.max(0, Math.min(selected, (this.review?.changes.length ?? 0) - 1)) : 0 };
    this.sequence++;
  }

  update(status: string, changes?: ChangePreview[]): void {
    if (!this.review) return;
    const pending = this.review.pending && ["Awaiting permission", "Ready to approve"].includes(status);
    const snapshots = changes && structuredClone(changes);
    const changed = snapshots && JSON.stringify(snapshots) !== JSON.stringify(this.review.changes);
    if (pending && changed) throw new Error("Publish a fresh review when proposed files change.");
    // Result documents have their own immutable URI identity when actual output
    // differs from the proposal. Already-open proposal tabs keep their content.
    const revision = this.review.revision + (changed ? 1 : 0);
    const fingerprint = changed ? createHash("sha256").update(JSON.stringify({ id: this.review.id, revision, changes: snapshots })).digest("hex") : this.review.fingerprint;
    if (!pending) { this.onDecision = undefined; this.validate = undefined; }
    this.review = freeze({ ...this.review, status, pending, revision, fingerprint, ...(snapshots ? { changes: snapshots } : {}) });
    this.sequence++;
  }

  record(input: { title: string; why: string; changes: ChangePreview[]; status: string; reviewId?: string }): BridgeReview {
    if (this.review?.pending) throw new Error("Finish the current permission review before opening a recorded result.");
    const id = input.reviewId ?? randomUUID();
    const snapshots = structuredClone(input.changes);
    const revision = 1;
    const fingerprint = createHash("sha256").update(JSON.stringify({ id, revision, changes: snapshots })).digest("hex");
    // History is read-only; old pending or question states never restore permission.
    const status = ["Awaiting permission", "Ready to approve", "Answering questions"].includes(input.status) ? "Recorded result" : input.status;
    this.review = freeze({ id, title: input.title, why: input.why, changes: snapshots, revision, fingerprint, pending: false, status });
    this.focus = undefined;
    this.onDecision = undefined; this.validate = undefined;
    this.sequence++;
    return this.current!;
  }

  decide(value: BridgeDecision): boolean {
    const decision = decisionFrom(value);
    if (!this.review?.pending) return false;
    if (decision.action === "approve") this.validate?.();
    const callback = this.onDecision;
    this.onDecision = undefined;
    this.validate = undefined;
    this.review = freeze({ ...this.review, pending: false, status: decision.action === "approve" ? "Approved" : "Denied" });
    this.sequence++;
    callback?.(decision);
    return true;
  }

  cancel(): void {
    this.terminalHandlers?.stop();
    if (this.commandProgress.length) { this.commandProgress = []; this.sequence++; }
    if (!this.review?.pending) return;
    this.decide({ action: "deny" });
    this.update("Cancelled");
  }

  close(): Promise<void> {
    const operation = this.lifecycle.then(() => this.stop());
    this.lifecycle = operation.catch(() => {});
    return operation;
  }

  private async stop(): Promise<void> {
    this.cancel();
    const server = this.server;
    this.server = undefined;
    this.registry = undefined;
    this.companionSeen=0;
    this.review = undefined;
    this.focus = undefined;
    this.onDecision = undefined;
    this.validate = undefined;
    if (this.registryPath) {
      try { unlinkSync(this.registryPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.registryPath = undefined;
    }
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  }

  private send(response: ServerResponse, status: number, body?: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const registry = this.registry;
    if (!registry) return this.send(response, 503, { error: "Pair review connection is starting." });
    const expected = Buffer.from("Bearer " + registry.token);
    const actual = Buffer.from(request.headers.authorization ?? "");
    if (request.headers.origin !== undefined || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      request.resume();
      return this.send(response, 401, { error: "Pair review authentication required." });
    }
    const path = request.url;
    if (request.method === "GET" && (path === "/review" || path === "/status")) {
      if(path==="/review")this.companionSeen=Date.now();
      const etag = `"${registry.sessionId}:${this.sequence}"`;
      response.setHeader("ETag", etag);
      if (request.headers["if-none-match"] === etag) return this.send(response, 304);
      const review = this.current;
      const summary = review && { id: review.id, revision: review.revision, fingerprint: review.fingerprint, gate: review.gate, title: review.title, why: review.why, status: review.status, pending: review.pending };
      return this.send(response, 200, { version: 1, sessionId: registry.sessionId, root: registry.root, review: (path === "/status" ? summary : review) ?? null, progress: this.progress, terminal: this.terminalState ?? null, ...(this.focus ? { focus: this.focus } : {}) });
    }
    if (!["/decision", "/terminal"].includes(path ?? "")) { request.resume(); return this.send(response, 404, { error: "Unknown Pair review endpoint." }); }
    if (request.method !== "POST") { request.resume(); return this.send(response, 405, { error: "Use POST for a review decision." }); }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      request.resume();
      return this.send(response, 400, { error: "Send a JSON review decision." });
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY) { this.send(response, 413, { error: "Review decision is too large." }); request.resume(); return; }
        chunks.push(buffer);
      }
      // A session may have closed while the request body was arriving.
      if (this.registry !== registry) return this.send(response, 409, { error: "The Pi session changed. Reconnect before responding." });
      if (path === "/terminal") {
        try{this.terminalAction(JSON.parse(Buffer.concat(chunks).toString("utf8")));return this.send(response,200,{ok:true});}
        catch(error){return this.send(response,409,{error:(error as Error).message});}
      }
      let body: Record<string, unknown>;
      let decision: BridgeDecision;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        decision = decisionFrom(body);
        if (body.gate !== undefined && (!Number.isSafeInteger(body.gate) || (body.gate as number) < 1)) throw new Error("Include a positive decision gate.");
        if (Object.keys(body).some((key) => !["reviewId", "revision", "fingerprint", "gate", "action", "note"].includes(key))) throw new Error("Unexpected review decision field.");
        if (typeof body.reviewId !== "string" || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1 || typeof body.fingerprint !== "string") throw new Error("Include the review ID, revision, and fingerprint.");
      } catch (error) { return this.send(response, 400, { error: error instanceof SyntaxError ? "Send a valid JSON review decision." : (error as Error).message }); }
      if (!this.review?.pending || body.reviewId !== this.review.id || body.revision !== this.review.revision || body.fingerprint !== this.review.fingerprint
        || (body.gate ?? 1) !== (this.review.gate ?? 1)) {
        return this.send(response, 409, { error: "This review is no longer pending. Refresh before deciding." });
      }
      try {
        if (!this.decide(decision)) return this.send(response, 409, { error: "This review was already decided." });
      } catch (error) {
        return this.send(response, 409, { error: String(error instanceof Error ? error.message : error).slice(0, 1000) || "The change cannot be approved. Refresh its preview." });
      }
      this.send(response, 200, { accepted: true, status: this.review?.status });
    } catch {
      if (!response.headersSent) this.send(response, 400, { error: "The review decision could not be read." });
    }
  }
}
