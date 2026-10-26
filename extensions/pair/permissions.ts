import { type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { snapshot, projectRoot } from "./files.ts";
import { ChangeSchema, assertUnchanged, filePreview, prepareChanges } from "./changes.ts";
import { normalizeStepDetails, renderStepCall, renderStepResult, type StepDetails } from "./history.ts";
import { showPermission, type ChangePreview } from "./ui.ts";
import { normalizeStepArguments } from "./context.ts";
import { companionInstalled, openCodeDiff, openCodeReview } from "./external.ts";
import { preparePairArguments } from "./validation.ts";
import { PairReviewBridge } from "./bridge.ts";
import { reviewWithCompanion } from "./review-connection.ts";
import { PROPOSAL_ENTRY, restoredProposal, reviseProposal, saveProposal, type SavedProposal } from "./proposals.ts";

export const REVIEW_EVENT_ENTRY = "pair-review-event-v1";

const Step = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 140, description: "One understandable decision or behavior change." }),
  why: Type.String({ minLength: 1, maxLength: 1800, description: "Explain purpose, mechanics, and meaningful choices concisely. Usually 1–3 sentences; avoid repeating the title." }),
  changes: Type.Optional(Type.Array(ChangeSchema, { minItems: 1, maxItems: 4, description: "Related edits/writes to 1–4 distinct files, or one standalone command. With revises, include only replacement files; other proposed files are retained." })),
  revises: Type.Optional(Type.String({ minLength: 8, maxLength: 128, description: "Exact review ID from section feedback. Retains unchanged proposed files and requires fresh approval." })),
});

interface Permit { tool: string; input: string; root: string; path?: string; hash?: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

// Parse only a small known Git grammar. Shell composition and arbitrary options
// still need approval; harmless flag variations do not create approval dialogs.
export function routineCommand(command: unknown): boolean {
  if (typeof command !== "string" || /[\r\n;&|><`$%!(){}@]/.test(command)) return false;
  if ([
    "git --version", "git status", "git status --short", "git status --short --branch",
    "git diff", "git diff --stat", "git diff --cached", "git diff --cached --stat",
    "git rev-parse --show-toplevel", "git branch --show-current", "git remote -v",
    "git init", "git init --initial-branch=main", "git init --initial-branch=main --template=",
  ].includes(command.trim())) return true;
  const parts = command.trim().match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? [];
  if (parts.join(" ") !== command.trim().replace(/\s+/g," ") || parts[0] !== "git") return false;
  const args = parts.slice(2).map(part => part.replace(/^(["'])(.*)\1$/, "$2"));
  if (parts[1] === "status") return args.every(arg => /^(?:--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files(?:=(?:all|normal|no))?)$/.test(arg));
  if (parts[1] !== "diff") return false;
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0,separator);
  return flags.every(arg => /^(?:--(?:check|stat|shortstat|numstat|name-only|name-status|cached|staged|no-color|no-ext-diff|no-textconv)|--color=never|-U\d+|--unified=\d+)$/.test(arg));
}

export function registerStepPermissions(pi: ExtensionAPI, options: {
  active: (ctx: ExtensionContext) => { root: string };
  changed: (ctx: ExtensionContext, changes?: ChangePreview[]) => void;
  review?: typeof showPermission;
  openExternal?: typeof openCodeDiff;
  bridge?: PairReviewBridge;
}) {
  // Injected terminal-only tests do not create a user-profile discovery server.
  const bridge = options.bridge ?? (options.review ? undefined : new PairReviewBridge());
  const proposals = new Map<string, SavedProposal>();
  let recoveryPending = false;
  bridge?.setReviewEventHandler(event => pi.appendEntry(REVIEW_EVENT_ENTRY, event));
  const retain = (proposal: SavedProposal) => {
    proposals.set(proposal.id, proposal);
    while (proposals.size > 8) proposals.delete(proposals.keys().next().value!);
  };
  let latest: StepDetails | undefined;
  let focusPending: (() => void) | undefined;
  const focusCurrent = () => { if (!focusPending) return false; focusPending(); return true; };
  let viewing = false;
  const remember = (result: AgentToolResult<StepDetails>, forGeneration = generation): AgentToolResult<StepDetails> => {
    if (forGeneration !== generation) return result;
    latest = result.details;
    if (latest) bridge?.update(latest.status, latest.changes);
    return result;
  };
  const external = async (ctx: ExtensionContext, changes: ChangePreview[], selected: number) => {
    if (!options.openExternal && bridge && companionInstalled()) {
      await bridge.start(options.active(ctx).root);
      bridge.requestFocus(selected);
      await openCodeReview(options.active(ctx).root);
      return;
    }
    const change = changes[selected];
    if (change?.before === undefined || change.after === undefined) throw new Error("This saved result has no complete file snapshots. Review its diff here.");
    await (options.openExternal ?? openCodeDiff)(change.label, change.before, change.after, ctx.cwd);
  };
  const permits = new Map<string, Permit>();
  const rejected = new Set<string>();
  let stopThisRun = false;
  let revisionNote: string | undefined;
  let generation = 0;
  const clear = () => { permits.clear(); rejected.clear(); stopThisRun = false; revisionNote = undefined; generation++; bridge?.cancel(); };
  pi.on("before_agent_start", clear);
  const restoreReview = (_event: unknown, ctx: ExtensionContext) => {
    clear(); latest = undefined; focusPending = undefined;
    // A restored branch must never keep another branch's editor review alive.
    void bridge?.close().catch(() => {});
    const branch = ctx.sessionManager.getBranch();
    const root = projectRoot(ctx.cwd);
    proposals.clear();
    const events: unknown[] = [];
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === REVIEW_EVENT_ENTRY) {
        events.push(entry.data);
        if ((entry.data as { kind?: string; root?: string })?.kind === "reset" && (entry.data as { root?: string }).root === root) { proposals.clear(); latest = undefined; }
      }
      if (entry.type === "custom" && entry.customType === PROPOSAL_ENTRY) {
        const proposal = restoredProposal(entry.data, root);
        if (proposal) retain(proposal);
      }
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "pair_step") continue;
      latest = normalizeStepDetails(entry.message.details, entry.message.content, entry.message.isError === true);
    }
    bridge?.restoreReviewEvents(events, root);
    recoveryPending = true;
  };
  pi.on("session_start", restoreReview);
  pi.on("session_tree", restoreReview);
  // Automatic compaction is still the same human turn: keep denials and revision feedback.
  pi.on("session_compact", () => { permits.clear(); generation++; bridge?.cancel(); recoveryPending = true; });
  pi.on("session_shutdown", async () => { clear(); await bridge?.close(); });

  const guard = (event: ToolCallEvent) => {
    const readOnly = ["read", "grep", "find", "ls"].includes(event.toolName)
      || event.toolName === "pair_work" && ["status", "checkpoint", "feedback"].includes((event.input as { action?: string }).action ?? "");
    if (stopThisRun && !readOnly) return { block: true as const, reason: "Pair: the human denied this step. Address their feedback and stop; do not retry through another tool." };
    const permit = event.parentToolCallId ? permits.get(event.parentToolCallId) : undefined;
    if (permit && event.toolName === permit.tool && canonical(event.input) === permit.input) {
      permits.delete(event.parentToolCallId!);
      if (permit.path && snapshot(permit.root, permit.path).hash !== permit.hash) {
        return { block: true as const, reason: "Pair: the file changed after the preview. Read it and request new permission." };
      }
      return;
    }
    if (revisionNote && !readOnly && event.toolName !== "pair_step") {
      return { block: true as const, reason: "Pair: follow the human's note: revise, skip, or discuss as requested. Any actual change needs fresh pair_step approval." };
    }
    if (readOnly || ["pair_step", "pair_work"].includes(event.toolName)) return;
    if (["bash", "powershell"].includes(event.toolName) && "command" in event.input && routineCommand(event.input.command)) return;
    return { block: true as const, reason: "Pair: use pair_step to explain one coherent step and show its exact edits for approval. Related files can share one request; no design or increment proposal is required." };
  };

  pi.registerTool<typeof Step, StepDetails>({
    name: "pair_step", label: "Step", parameters: Step, executionMode: "sequential", renderShell: "self",
    description: "Explain and request approval for one coherent step across up to four files, or one command. Approved actions run in order; failure stops the rest without rollback. Deny stops; a note permits a revised proposal for fresh approval. History reports success.",
    prepareArguments: preparePairArguments("pair_step", Step, normalizeStepArguments),
    reachesTools: (input) => {
      const changes = [...(input.changes as { tool?: string }[] ?? []), ...(typeof input.revises === "string" ? proposals.get(input.revises)?.changes ?? [] : [])];
      return [...new Set(changes.flatMap((change) => change.tool ? [change.tool] : []))];
    },
    async execute(id, params, signal, update, ctx) {
      const { root } = options.active(ctx);
      const requestGeneration = generation;
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Step permissions require Pi's interactive terminal.");
      if (stopThisRun) throw new Error("The human denied this step. Stop until they continue.");
      if (!params.changes && !params.revises) throw new Error("Supply changes, or a review ID in revises to retain its proposed files.");
      const previous = params.revises ? proposals.get(params.revises) : undefined;
      if (params.revises && (!previous || latest?.reviewId !== params.revises || !bridge?.archived(params.revises))) throw new Error("That is not the latest retained proposal. Read the current files and prepare a fresh step.");
      const inputs = previous ? reviseProposal(root, previous, params.changes) : params.changes!;
      for (const change of inputs) {
        if (!ctx.tools.some((entry) => entry.name === change.tool)) throw new Error(`The ${change.tool} tool is unavailable.`);
      }
      const prepared = await prepareChanges(root, inputs, signal);
      if (requestGeneration !== generation) throw new Error("The session changed while preparing the preview. Nothing was published or executed.");
      const fingerprint = canonical(prepared.map((change) => ({ tool: change.tool, input: change.input })));
      if (rejected.has(fingerprint)) throw new Error("This exact step was denied. Incorporate the note into a different change or ask a clarification question; do not repeat the same permission request.");
      const previews = prepared.map((change) => change.preview);
      const details: StepDetails = { title: params.title.trim(), why: params.why.trim(), status: "Awaiting permission", changes: previews, revises: params.revises };
      if (!details.title || !details.why) throw new Error("Explain the change and why it is needed.");
      // Keep the rationale in the dialog while pending instead of duplicating it behind the overlay.
      latest = details;
      update?.({ content: [{ type: "text", text: "Awaiting permission." }], details });
      const decision = await reviewWithCompanion(bridge, root, ctx, details.title, details.why, previews, signal, {
        onOpenExternal: (selected) => external(ctx, previews, selected),
        onHandle: (handle) => { focusPending = () => { handle.setHidden(false); handle.focus(); }; },
        onClose: () => { focusPending = undefined; },
      }, () => {
        signal?.throwIfAborted();
        if (requestGeneration !== generation) throw new Error("The Pi session changed. Request a fresh review.");
        options.active(ctx);
        assertUnchanged(root, prepared);
      }, options.review ?? showPermission, {
        revises: params.revises,
        onPublished(review) {
          const saved = saveProposal(review.id, root, details.title, details.why, inputs, prepared);
          pi.appendEntry(PROPOSAL_ENTRY, saved);
          retain(saved);
          details.reviewId = review.id;
        },
      });
      if (requestGeneration !== generation) throw new Error("The session changed while permission was open. Nothing was executed.");
      if (decision.action !== "approve" || signal?.aborted) {
        if (decision.feedback && !signal?.aborted) {
          const feedback = decision.feedback;
          rejected.add(fingerprint);
          stopThisRun = feedback.intent === "ask";
          revisionNote = stopThisRun ? undefined : "Follow the submitted section feedback.";
          const status = stopThisRun ? "Discussion requested" : "Revision requested";
          const notes = feedback.threads.map(thread => `[${thread.id}] ${thread.intent === "ask" ? "Ask" : "Request change"}: ${thread.label}, ${thread.side} lines ${thread.startLine}–${thread.endLine}\n${thread.text}\nSelected code: ${thread.excerpt.slice(0, 600)}`).join("\n\n");
          return remember({ content: [{ type: "text", text: `Nothing was applied. Section feedback for review ${feedback.reviewId}:\n${notes}\n\n` + (stopThisRun
            ? "Answer the questions with pair_work action feedback and replies [{threadId,text}], then stop for the human. Do not propose or execute changes this run."
            : `Revise the affected files with pair_step revises: ${feedback.reviewId}. Include only replacement file changes; the other proposed files are retained. Explain the correction and request fresh approval.`) }],
            details: { ...details, status, note: feedback.threads.map(thread => thread.text).join("\n"), changes: previews.map(preview => ({ ...preview, status: "Proposed — not applied" })) },
          }, requestGeneration);
        }
        const note = decision.note;
        rejected.add(fingerprint);
        revisionNote = !signal?.aborted ? note : undefined;
        stopThisRun = !revisionNote;
        const status = signal?.aborted ? "Cancelled" : "Denied";
        const changes = previews.map((preview) => ({ ...preview, status: "Proposed — not applied" }));
        pi.appendEntry("pair-step-v1", { title: details.title, status, note, files: previews.map((preview) => preview.label) });
        return remember({
          content: [{ type: "text", text: note && !stopThisRun
            ? `Nothing was applied. Human feedback: ${note}\nFollow its intent: revise with a fresh proposal, skip the action, or explain before proposing. Ask only if necessary. Never execute without fresh approval or repeat the rejected step.`
            : "Nothing was applied. The human denied this step. Acknowledge briefly and stop; do not try an alternative mutation." }],
          details: { ...details, status, note, changes },
        }, requestGeneration);
      }
      revisionNote = undefined;
      const completed: ChangePreview[] = previews.map((preview) => ({ ...preview, status: "Not run — proposed" }));
      const outputs: string[] = [];
      let applied = 0;
      let failed = false;
      let terminate = false;
      pi.appendEntry("pair-step-v1", { title: details.title, status: "Approved once", files: previews.map((preview) => preview.label), why: details.why });
      for (let index = 0; index < prepared.length; index++) {
        const change = prepared[index];
        try {
          signal?.throwIfAborted();
          if (requestGeneration !== generation) throw new Error("The session changed; remaining actions were not run.");
          assertUnchanged(root, prepared.slice(index));
          latest = { ...details, status: `Applying ${index + 1}/${prepared.length} · ${change.preview.label}`, changes: completed };
          bridge?.update(latest.status, completed);
          update?.({ content: [{ type: "text", text: "Running approved step." }], details: latest });
          permits.set(id, { tool: change.tool, input: canonical(change.input), root, path: change.path, hash: change.before?.hash });
          const outcome = await ctx.executeTool(change.tool, change.input, { signal });
          if (requestGeneration !== generation) throw new Error("The session changed while this action ran. Inspect its files; remaining actions were not run.");
          terminate = Boolean(outcome.result.terminate);
          const output = outcome.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
          outputs.push(`${change.preview.label}:\n${output}`);
          let actual = change.preview;
          if (change.path) {
            const after = snapshot(root, change.path);
            actual = { ...filePreview(change.path, change.before?.text ?? "", after.text ?? "", change.preview.kind), why: change.preview.why, annotations: change.preview.annotations };
            // Other hooks may change/reject an edit. Stop if the actual file differs from the reviewed result.
            if (!outcome.isError && after.text !== change.after) throw new Error(`The actual result in ${change.path} differs from the reviewed change. Inspect before proceeding.`);
          } else actual = { ...change.preview, text: [change.preview.text, output].filter(Boolean).join("\n\n") };
          failed = outcome.isError;
          completed[index] = { ...actual, status: failed ? "Failed — inspect result" : change.path ? "Applied" : "Completed" };
          if (!failed) applied++;
          if (failed || terminate) break;
        } catch (error) {
          failed = true;
          outputs.push(`${change.preview.label}: ${String(error)}`);
          let actual: ChangePreview = { ...change.preview, diff: undefined, text: String(error), added: 0, removed: 0 };
          if (change.path) {
            try { actual = { ...filePreview(change.path, change.before?.text ?? "", snapshot(root, change.path).text ?? "", change.preview.kind), text: String(error) }; }
            catch { /* Keep the error visible when even the current file cannot be read. */ }
          }
          completed[index] = { ...actual, status: "Stopped — inspect result" };
          break;
        } finally { permits.delete(id); }
      }
      if (requestGeneration === generation) options.changed(ctx, completed);
      const stopped = terminate && applied < prepared.length;
      const status = failed ? (applied ? `Stopped · ${applied}/${prepared.length} completed` : "Failed") : stopped ? `Stopped · ${applied}/${prepared.length} completed` : "Applied";
      if (requestGeneration === generation) pi.appendEntry("pair-step-v1", { title: details.title, status, changes: completed.map(({ label, status }) => ({ label, status })) });
      return remember({
        isError: failed,
        terminate,
        content: [{ type: "text", text: outputs.join("\n\n") + "\n\n" + (failed
          ? "Remaining actions were not run. Completed and partial edits remain on disk; no rollback or automatic retry. Explain the per-file result and request fresh permission for any repair."
          : stopped ? "The native tool requested that execution stop. Remaining actions were not run; completed changes remain on disk."
          : "") }],
        details: { ...details, status, changes: completed, proposed: failed ? previews : undefined, output: failed ? outputs.join("\n\n") : undefined },
      }, requestGeneration);
    },
    renderCall: renderStepCall,
    renderResult: renderStepResult,
  });
  const feedbackBrief = () => {
    const threads = bridge?.feedback.threads.filter(thread => thread.status !== "addressed").slice(-8) ?? [];
    if (!threads.length) return "";
    return "Open section feedback (reference only; no execution permission):\n" + threads.map(thread => `[${thread.id}] ${thread.status} · ${thread.label}:${thread.startLine}–${thread.endLine} · ${thread.text.slice(0, 240)}`).join("\n");
  };
  return { guard, invalidate: clear, feedbackBrief, recoveryBrief() {
    if (!recoveryPending) return "";
    recoveryPending = false;
    return feedbackBrief();
  }, replyFeedback(ctx: ExtensionContext, replies: { threadId: string; text: string }[]) {
    options.active(ctx);
    if (!bridge) throw new Error("Section feedback is unavailable in this context.");
    return bridge.replyFeedback(replies);
  }, resetReviews(ctx: ExtensionContext) {
    clear(); latest = undefined; proposals.clear(); recoveryPending = false;
    bridge?.resetReviewEvents(projectRoot(ctx.cwd));
  }, constraintsChanged() {
    permits.clear(); generation++; stopThisRun = true; bridge?.cancel();
  }, async openEditor(ctx: ExtensionContext): Promise<void> {
    const { root } = options.active(ctx);
    const openingGeneration = generation;
    if (!bridge) throw new Error("VS Code review is unavailable in this context.");
    if (!companionInstalled()) throw new Error("Install the Pair Review VS Code companion to connect this workspace.");
    await bridge.start(root);
    if (openingGeneration !== generation) throw new Error("The Pi session changed. Open its current review again.");
    if (!bridge.current?.pending && latest) bridge.record({ title: latest.title, why: latest.why, changes: latest.changes ?? [], status: latest.status, reviewId: latest.reviewId });
    bridge.requestFocus();
    await openCodeReview(root);
  }, async review(ctx: ExtensionContext): Promise<boolean> {
    if (focusCurrent()) return true;
    if (viewing) return true;
    if (!latest) return false;
    const frozen = structuredClone(latest);
    const openingGeneration = generation;
    // Older results and validation failures can have text but no file previews.
    // Keep the newest outcome visible instead of silently reopening an older success.
    const changes = frozen.changes?.length ? frozen.changes : [{
      label: "Saved tool result", kind: "Result", added: 0, removed: 0,
      text: [frozen.patch, frozen.output].filter(Boolean).join("\n\n") || "No further result details were recorded.",
    }];
    viewing = true;
    try {
      if (bridge) {
        try {
          await bridge.start(options.active(ctx).root);
          if (openingGeneration !== generation) return true;
          if (focusCurrent()) return true;
          // Another proposal may have arrived during asynchronous startup.
          // Reading history must never replace its pending decision.
          if (bridge.current?.pending) return true;
          bridge.record({ title: frozen.title, why: frozen.why, changes, status: frozen.status, reviewId: frozen.reviewId });
        }
        catch { /* Terminal review remains usable if local discovery is unavailable. */ }
      }
      if (openingGeneration !== generation) return true;
      if (focusCurrent() || bridge?.current?.pending) return true;
      await (options.review ?? showPermission)(ctx, `${frozen.status} · ${frozen.title}`, frozen.why, changes, undefined, {
        readOnly: true, onOpenExternal: (selected) => external(ctx, changes, selected),
      });
    } finally { viewing = false; }
    return true;
  } };
}
