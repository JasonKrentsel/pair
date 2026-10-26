import { type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { outputTail } from "./command-output.ts";
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
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 140, description: "One understandable decision or behavior change. Omit with resume." })),
  why: Type.Optional(Type.String({ minLength: 1, maxLength: 1800, description: "Explain purpose, mechanics, and meaningful choices concisely. Usually 1–3 sentences; omit with resume." })),
  changes: Type.Optional(Type.Array(ChangeSchema, { minItems: 1, maxItems: 8, description: "1–8 ordered edits, writes, or commands; at most four distinct files. With revises, replace files in place; retain other actions. Command or order changes need a fresh complete step." })),
  revises: Type.Optional(Type.String({ minLength: 8, maxLength: 128, description: "Exact review ID from section feedback. Retains unchanged proposed files and requires fresh approval." })),
  resume: Type.Optional(Type.String({ minLength: 8, maxLength: 128, description: "After answering a question-only batch, reopen that exact retained step for human approval. Supply only resume; no code, title, why, or changes." })),
}, { anyOf: [{ required: ["title", "why"] }, { required: ["resume"] }] });

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
  let questionPause: { reviewId: string; generation: number; threadIds: string[] } | undefined;
  let generation = 0;
  const clear = () => { permits.clear(); rejected.clear(); stopThisRun = false; revisionNote = undefined; questionPause = undefined; generation++; bridge?.cancel(); };
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
  pi.on("session_compact", () => { permits.clear(); questionPause = undefined; generation++; bridge?.cancel(); recoveryPending = true; });
  pi.on("session_shutdown", async () => { clear(); await bridge?.close(); });

  const guard = (event: ToolCallEvent) => {
    const readOnly = ["read", "grep", "find", "ls"].includes(event.toolName)
      || event.toolName === "pair_work" && ["status", "checkpoint", "feedback"].includes((event.input as { action?: string }).action ?? "");
    const input = event.input as Record<string, unknown>;
    const resumesQuestion = event.toolName === "pair_step" && questionPause?.generation === generation && input.resume === questionPause.reviewId;
    if (stopThisRun && !readOnly && !resumesQuestion) return { block: true as const, reason: questionPause
      ? "Pair: answer the inline questions, then resume the exact retained step for human approval. Other mutations remain paused."
      : "Pair: the human denied this step. Address their feedback and stop; do not retry through another tool." };
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
    description: "Explain and request approval for one coherent step of 1–8 ordered edits, writes, or commands across up to four files. Approved actions run in order; failure stops the rest without rollback. Deny stops; a note permits a revised proposal for fresh approval. History reports success.",
    prepareArguments: preparePairArguments("pair_step", Step, normalizeStepArguments),
    reachesTools: (input) => {
      const retainedId = typeof input.resume === "string" ? input.resume : typeof input.revises === "string" ? input.revises : undefined;
      const changes = [...(input.changes as { tool?: string }[] ?? []), ...(retainedId ? proposals.get(retainedId)?.changes ?? [] : [])];
      return [...new Set(changes.flatMap((change) => change.tool ? [change.tool] : []))];
    },
    async execute(id, params, signal, update, ctx) {
      const { root } = options.active(ctx);
      const requestGeneration = generation;
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Step permissions require Pi's interactive terminal.");
      if (params.resume && (params.title !== undefined || params.why !== undefined || params.changes !== undefined || params.revises !== undefined))
        throw new Error("Supply only resume to reopen the exact retained step; propose changed actions separately.");
      const pause = params.resume ? questionPause : undefined;
      if (params.resume && (!pause || pause.reviewId !== params.resume || pause.generation !== generation || !bridge?.questionPending))
        throw new Error("This question pause is no longer resumable. Request a fresh step.");
      if (pause && !pause.threadIds.every(id => bridge?.feedback.threads.some(thread => thread.id === id && !!thread.reply)))
        throw new Error("Answer every question before resuming the step.");
      if (stopThisRun && !pause) throw new Error("The human denied this step. Stop until they continue.");
      if (!params.resume && (!params.title?.trim() || !params.why?.trim())) throw new Error("Supply title and why for a new or revised step.");
      if (!params.changes && !params.revises && !params.resume) throw new Error("Supply changes, revises, or resume for an answered question pause.");
      const retainedId = params.resume ?? params.revises;
      const previous = retainedId ? proposals.get(retainedId) : undefined;
      if (retainedId && (!previous || latest?.reviewId !== retainedId || !bridge?.archived(retainedId))) throw new Error("That is not the latest retained proposal. Read the current files and prepare a fresh step.");
      let inputs: SavedProposal["changes"];
      try { inputs = previous ? reviseProposal(root, previous, params.changes) : params.changes!; }
      catch (error) { if (params.resume) { questionPause = undefined; bridge?.cancel(); } throw error; }
      for (const change of inputs) {
        if (!ctx.tools.some((entry) => entry.name === change.tool)) throw new Error(`The ${change.tool} tool is unavailable.`);
      }
      let prepared: Awaited<ReturnType<typeof prepareChanges>>;
      try { prepared = await prepareChanges(root, inputs, signal); }
      catch (error) { if (params.resume) { questionPause = undefined; bridge?.cancel(); } throw error; }
      if (requestGeneration !== generation) throw new Error("The session changed while preparing the preview. Nothing was published or executed.");
      const fingerprint = canonical(prepared.map((change) => ({ tool: change.tool, input: change.input })));
      if (rejected.has(fingerprint)) throw new Error("This exact step was denied. Incorporate the note into a different change or ask a clarification question; do not repeat the same permission request.");
      const previews = prepared.map((change) => change.preview);
      const details: StepDetails = { title: params.resume ? previous!.title : params.title!.trim(), why: params.resume ? previous!.why : params.why!.trim(),
        status: params.resume ? "Ready to approve" : "Awaiting permission", changes: previews, revises: params.revises,
        ...(params.resume ? { reviewId: params.resume } : {}) };
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
        revises: params.revises, resume: params.resume,
        onPublished(review) {
          if (params.resume) { questionPause = undefined; stopThisRun = false; details.reviewId = review.id; return; }
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
          const questionsOnly = feedback.threads.every(thread => thread.intent === "ask");
          if (!questionsOnly) rejected.add(fingerprint);
          questionPause = questionsOnly ? { reviewId: feedback.reviewId, generation, threadIds: feedback.threads.map(thread => thread.id) } : undefined;
          stopThisRun = feedback.intent === "ask";
          revisionNote = stopThisRun ? undefined : "Follow the submitted section feedback.";
          const status = questionsOnly ? "Answering questions" : "Revision requested";
          const notes = feedback.threads.map(thread => `[${thread.id}] ${thread.intent === "ask" ? "Ask" : "Request change"}: ${thread.label}, ${thread.side} lines ${thread.startLine}–${thread.endLine}\n${thread.text}\nSelected code: ${thread.excerpt.slice(0, 600)}`).join("\n\n");
          return remember({ content: [{ type: "text", text: `Nothing was applied. Section feedback for review ${feedback.reviewId}:\n${notes}\n\n` + (stopThisRun
            ? questionsOnly
              ? `Answer every question with pair_work action feedback and replies [{threadId,text}]. Its receipt will give the exact reference-only call to resume this unchanged step for human approval. Do not resend code or execute without approval.`
              : "Answer the questions with pair_work action feedback and replies [{threadId,text}], then stop for the human. Requested revisions still need a fresh proposal; do not resume this unchanged step."
            : feedback.threads.some(thread => thread.side === "command")
              ? "Prepare a fresh complete pair_step for the requested command correction. Include every ordered action and request fresh approval; command revisions cannot reuse a retained file-only replacement."
              : `Revise the affected files with pair_step revises: ${feedback.reviewId}. Include only replacement file changes; other actions and their order are retained. Command or execution-order changes need a fresh complete step. Explain the correction and request fresh approval.`) }],
            details: { ...details, status, note: feedback.threads.map(thread => thread.text).join("\n"), changes: questionsOnly ? previews : previews.map(preview => ({ ...preview, status: "Proposed — not applied" })) },
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
        let acceptingOutput = true, streamed = "", lastUpdate = 0;
        const publishOutput = (status: "Running" | "Completed" | "Failed", value: string) => {
          if (requestGeneration !== generation) return;
          streamed = value;
          if (details.reviewId) bridge?.setCommandProgress(details.reviewId, index, status, value);
          latest = { ...latest!, stream: { status, ...outputTail(value) } };
          update?.({ content: [{ type: "text", text: "Running approved step." }], details: latest });
        };
        try {
          signal?.throwIfAborted();
          if (requestGeneration !== generation) throw new Error("The session changed; remaining actions were not run.");
          assertUnchanged(root, prepared.slice(index));
          completed[index] = { ...change.preview, status: "Running" };
          latest = { ...details, status: `Applying ${index + 1}/${prepared.length} · ${change.path ? change.preview.label : change.tool + " command"}`, changes: completed };
          bridge?.update(latest.status, completed);
          update?.({ content: [{ type: "text", text: "Running approved step." }], details: latest });
          permits.set(id, { tool: change.tool, input: canonical(change.input), root, path: change.path, hash: change.before?.hash });
          if (!change.path) publishOutput("Running", "");
          const outcome = await ctx.executeTool(change.tool, change.input, { signal, onUpdate: !change.path ? partial => {
            if (!acceptingOutput || requestGeneration !== generation) return;
            streamed = partial.content.filter(item => item.type === "text").map(item => item.text).join("\n");
            if (Date.now() - lastUpdate < 100) return;
            lastUpdate = Date.now();
            publishOutput("Running", streamed);
          } : undefined });
          acceptingOutput = false;
          if (requestGeneration !== generation) throw new Error("The session changed while this action ran. Inspect its files; remaining actions were not run.");
          terminate = Boolean(outcome.result.terminate);
          const output = outcome.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
          if (!change.path) publishOutput(outcome.isError ? "Failed" : "Completed", output);
          outputs.push(`${change.preview.label}:\n${output}`);
          let actual = change.preview;
          if (change.path) {
            const after = snapshot(root, change.path);
            actual = { ...filePreview(change.path, change.before?.text ?? "", after.text ?? "", change.preview.kind), why: change.preview.why, annotations: change.preview.annotations };
            // Other hooks may change/reject an edit. Stop if the actual file differs from the reviewed result.
            if (!outcome.isError && after.text !== change.after) throw new Error(`The actual result in ${change.path} differs from the reviewed change. Inspect before proceeding.`);
          } else actual = { ...change.preview, text: output };
          failed = outcome.isError;
          completed[index] = { ...actual, status: failed ? "Failed — inspect result" : change.path ? "Applied" : "Completed" };
          if (!failed) applied++;
          if (failed || terminate) break;
        } catch (error) {
          acceptingOutput = false;
          if (!change.path) publishOutput("Failed", [streamed, String(error)].filter(Boolean).join("\n"));
          failed = true;
          const failureOutput = !change.path ? [outputTail(streamed).text, String(error)].filter(Boolean).join("\n") : String(error);
          outputs.push(`${change.preview.label}: ${failureOutput}`);
          let actual: ChangePreview = { ...change.preview, diff: undefined, text: failureOutput, added: 0, removed: 0 };
          if (change.path) {
            try { actual = { ...filePreview(change.path, change.before?.text ?? "", snapshot(root, change.path).text ?? "", change.preview.kind), text: String(error) }; }
            catch { /* Keep the error visible when even the current file cannot be read. */ }
          }
          completed[index] = { ...actual, status: "Stopped — inspect result" };
          break;
        } finally { acceptingOutput = false; permits.delete(id); }
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
    const feedback = bridge.replyFeedback(replies);
    const resume = questionPause?.generation === generation && bridge.questionPending
      && questionPause.threadIds.every(id => feedback.threads.some(thread => thread.id === id && !!thread.reply))
      ? questionPause.reviewId : undefined;
    return { ...feedback, resume };
  }, resetReviews(ctx: ExtensionContext) {
    clear(); latest = undefined; proposals.clear(); recoveryPending = false;
    bridge?.resetReviewEvents(projectRoot(ctx.cwd));
  }, constraintsChanged() {
    permits.clear(); questionPause = undefined; generation++; stopThisRun = true; bridge?.cancel();
  }, async openEditor(ctx: ExtensionContext): Promise<void> {
    const { root } = options.active(ctx);
    const openingGeneration = generation;
    if (!bridge) throw new Error("VS Code review is unavailable in this context.");
    if (!companionInstalled()) throw new Error("Install the Pair Review VS Code companion to connect this workspace.");
    await bridge.start(root);
    if (openingGeneration !== generation) throw new Error("The Pi session changed. Open its current review again.");
    if (!bridge.current?.pending && !bridge.questionPending && latest) bridge.record({ title: latest.title, why: latest.why, changes: latest.changes ?? [], status: latest.status, reviewId: latest.reviewId });
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
          if (bridge.current?.pending || bridge.questionPending) return true;
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
