import { type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { ActionConversations, type ActionSessionFactory } from "./action-conversations.ts";
import { registerInteractiveTerminal } from "./interactive-terminal.ts";
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
// Old reset journal entries remain readable without restoring removed feedback state.
const LEGACY_REVIEW_EVENT_ENTRY = "pair-review-event-v1";
const REVIEW_RESET_ENTRY = "pair-review-reset-v1";

const Step = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 140, description: "One understandable decision or behavior change." }),
  why: Type.String({ minLength: 1, maxLength: 1800, description: "Explain purpose, mechanics, and meaningful choices concisely in Markdown. Usually 1–3 sentences." }),
  changes: Type.Array(ChangeSchema, { minItems: 1, maxItems: 8, description: "1–8 ordered edits, writes, or commands; at most four distinct files. Every revised step needs its complete action list and fresh approval." }),
}, { additionalProperties: false });

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
  actionSessionFactory?: ActionSessionFactory;
}) {
  // Injected terminal-only tests do not create a user-profile discovery server.
  const bridge = options.bridge ?? (options.review ? undefined : new PairReviewBridge());
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
  const terminal = registerInteractiveTerminal(pi,bridge);
  const permits = new Map<string, Permit>();
  const rejected = new Set<string>();
  let stopThisRun = false;
  let revisionNote: string | undefined;
  let generation = 0;
  const clear = () => { terminal.clear(); permits.clear(); rejected.clear(); stopThisRun = false; revisionNote = undefined; generation++; bridge?.cancel(); };
  pi.on("before_agent_start", clear);
  const restoreReview = (_event: unknown, ctx: ExtensionContext) => {
    clear(); latest = undefined; focusPending = undefined;
    // A restored branch must never keep another branch's editor review alive.
    void bridge?.close().catch(() => {});
    const branch = ctx.sessionManager.getBranch();
    const root = projectRoot(ctx.cwd);
    for (const entry of branch) {
      if (entry.type === "custom" && (entry.customType === REVIEW_RESET_ENTRY || entry.customType === LEGACY_REVIEW_EVENT_ENTRY)
        && (entry.data as { kind?: string; root?: string })?.kind === "reset" && (entry.data as { root?: string }).root === root) latest = undefined;
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "pair_step") continue;
      latest = normalizeStepDetails(entry.message.details, entry.message.content, entry.message.isError === true);
    }
  };
  pi.on("session_start", restoreReview);
  pi.on("session_tree", restoreReview);
  // Automatic compaction is still the same human turn: keep denials and revision feedback.
  pi.on("session_compact", () => { terminal.clear(); permits.clear(); generation++; bridge?.cancel(); });
  pi.on("session_shutdown", async () => { clear(); await bridge?.close(); });

  const guard = (event: ToolCallEvent) => {
    const readOnly = ["read", "grep", "find", "ls"].includes(event.toolName)
      || event.toolName === "pair_work" && (event.input as { action?: string }).action === "status";
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
    description: "Explain and request approval for one coherent step of 1–8 ordered edits, writes, or commands across up to four files. Approved actions run in order; failure stops the rest without rollback. Deny stops; a note permits a revised proposal for fresh approval. History reports success. Use interactive:true for input prompts or terminal applications; type in VS Code after approval.",
    prepareArguments: preparePairArguments("pair_step", Step, normalizeStepArguments),
    reachesTools: (input) => {
      const changes = input.changes as { tool?: string; interactive?: boolean }[] ?? [];
      return [...new Set(changes.flatMap((change) => change.tool ? ["interactive" in change && change.interactive ? "pair_terminal" : change.tool] : []))];
    },
    async execute(id, params, signal, update, ctx) {
      const { root } = options.active(ctx);
      const requestGeneration = generation;
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Step permissions require Pi's interactive terminal.");
      if (stopThisRun) throw new Error("The human denied this step. Stop until they continue.");
      if (!params.title?.trim() || !params.why?.trim()) throw new Error("Supply title and why for the step.");
      const inputs = params.changes;
      for (const change of inputs) {
        if (!ctx.tools.some((entry) => entry.name === change.tool)) throw new Error(`The ${change.tool} tool is unavailable.`);
      }
      let prepared = await prepareChanges(root, inputs, signal);
      if (requestGeneration !== generation) throw new Error("The session changed while preparing the preview. Nothing was published or executed.");
      let fingerprint = canonical(prepared.map((change) => ({ tool: change.tool, input: change.input })));
      if (rejected.has(fingerprint)) throw new Error("This exact step was denied. Incorporate the note into a different change or ask a clarification question; do not repeat the same permission request.");
      let previews = prepared.map((change) => change.preview);
      const details: StepDetails = { title: params.title.trim(), why: params.why.trim(), status: "Awaiting permission", changes: previews };
      if (!details.title || !details.why) throw new Error("Explain the change and why it is needed.");
      // Keep the rationale in the dialog while pending instead of duplicating it behind the overlay.
      latest = details;
      update?.({ content: [{ type: "text", text: "Awaiting permission." }], details });
      const adopted = new Map<number,string>();
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
        onPublished(review) {
          details.reviewId = review.id;
          bridge?.setConversations(new ActionConversations({bridge,ctx,root,toolCallId:id,factory:options.actionSessionFactory,getPrepared:()=>prepared,
            adopt(next,index,summary) {
              const nextFingerprint=canonical(next.map(change=>({tool:change.tool,input:change.input})));
              if(rejected.has(nextFingerprint))throw new Error("This exact step was already denied. Request a different revision.");
              prepared=next; previews=next.map(change=>change.preview); details.changes=previews; fingerprint=nextFingerprint;
              adopted.set(index,summary); latest=details;
              // Rendering is advisory and must occur after the bridge commits its
              // matching approval identity. A UI failure cannot split that transaction.
              queueMicrotask(() => {
                try { update?.({content:[{type:"text",text:"Revision ready. Awaiting permission."}],details}); }
                catch { /* The companion still holds the exact updated proposal. */ }
              });
            },
          }));
        },
      });
      if (requestGeneration !== generation) throw new Error("The session changed while permission was open. Nothing was executed.");
      if (decision.action !== "approve" || signal?.aborted) {
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
      if(prepared.some(change=>change.preview.interactive) && !bridge?.companionConnected)throw new Error("Open the Pair view in VS Code, then propose this interactive step again. Nothing was executed.");
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
          const interactive = change.preview.interactive;
          if(interactive && (!bridge || !details.reviewId))throw new Error("Open this step in VS Code before running an interactive command.");
          const executionTool = interactive ? "pair_terminal" : change.tool;
          const {interactive: _interactive, ...nativeInput} = change.input;
          const executionInput = interactive ? terminal.grant({root,reviewId:details.reviewId!,index,shell:change.tool,command:change.preview.command!,timeout:change.input.timeout as number|undefined}) : nativeInput;
          permits.set(id, { tool: executionTool, input: canonical(executionInput), root, path: change.path, hash: change.before?.hash });
          if (!change.path) publishOutput("Running", "");
          const outcome = await ctx.executeTool(executionTool, executionInput, { signal, onUpdate: !change.path ? partial => {
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
          if (!change.path) publishOutput(outcome.isError ? "Failed" : "Completed", (outcome.result.details as {raw?:string}|undefined)?.raw ?? output);
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
        content: [{ type: "text", text: outputs.join("\n\n") + (adopted.size ? "\n\nHuman-adjusted actions (the original tool arguments were superseded):\n" + [...adopted].map(([index,summary]) => {
          const actual=completed[index]; const detail=actual.command ?? actual.diff ?? "";
          return "Action " + (index+1) + ": " + summary.slice(0,500) + "\nOutcome: " + actual.status + "\n" + detail.slice(0,8000) + (detail.length>8000 ? "\n[Truncated; read the file for current contents.]" : "");
        }).join("\n\n") : "") + "\n\n" + (failed
          ? "Remaining actions were not run. Completed and partial edits remain on disk; no rollback or automatic retry. Explain the per-file result and request fresh permission for any repair."
          : stopped ? "The native tool requested that execution stop. Remaining actions were not run; completed changes remain on disk."
          : "") }],
        details: { ...details, status, changes: completed, proposed: failed ? previews : undefined, output: failed ? outputs.join("\n\n") : undefined },
      }, requestGeneration);
    },
    renderCall: renderStepCall,
    renderResult: renderStepResult,
  });
  return { guard, invalidate: clear, resetReviews(ctx: ExtensionContext) {
    clear(); latest = undefined;
    pi.appendEntry(REVIEW_RESET_ENTRY, { kind: "reset", root: projectRoot(ctx.cwd) });
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
