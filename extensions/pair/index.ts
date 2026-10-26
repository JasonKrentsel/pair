import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { changedSinceObservation, normalizedFile, observeFiles, projectRoot, reviewDiff, saveDesign, snapshot } from "./files.ts";
import { STATE_ENTRY, phaseLabels, reopenDesign, type PairState } from "./state.ts";
import { plain, showPanel, updateWidget, type PanelView } from "./ui.ts";
import { registerStepPermissions } from "./permissions.ts";
import { preparePairArguments } from "./validation.ts";
import { conciseState, pairWorkResult, withPairContract } from "./context.ts";
import { classifyDesignApproval } from "./chat-approval.ts";
import { PairReviewBridge, type MemoryMutation } from "./bridge.ts";
import { addConstraint, expireTurnConstraints, markCheckpointStale, normalizeMemory, removeConstraint, updateCheckpoint, compactMemory, type WorkMemory } from "./checkpoint.ts";
import { showCheckpoint } from "./checkpoint-ui.ts";

const CheckpointPatch = Type.Object({
  objective: Type.Optional(Type.String({ maxLength: 240 })),
  implemented: Type.Optional(Type.String({ maxLength: 600 })),
  verification: Type.Optional(Type.String({ maxLength: 600, description: "Checks actually performed, results, and limits. Never infer unrun verification." })),
  usable: Type.Optional(Type.String({ maxLength: 600, description: "What can be used now; distinguish tested internals from integrated behavior." })),
  deferred: Type.Optional(Type.String({ maxLength: 600 })),
  next: Type.Optional(Type.String({ maxLength: 300 })),
}, { additionalProperties: false });

const Params = Type.Object({
  action: Type.Union(["status", "revise", "design", "approve_design", "checkpoint", "feedback"].map((value) => Type.Literal(value))),
  replies: Type.Optional(Type.Array(Type.Object({
    threadId: Type.String({ minLength: 1, maxLength: 100 }),
    text: Type.String({ minLength: 1, maxLength: 1200, description: "Concise Markdown answer to this section's question. Does not resolve human feedback or grant permission." }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 })),
  checkpoint: Type.Optional(CheckpointPatch),
  design_path: Type.Optional(Type.String({ description: "Optional project-relative Markdown path when establishing or importing a design. Defaults to docs/design/pair.md." })),
  target: Type.Optional(Type.Union([Type.Literal("design"), Type.Literal("increment")], { description: "For revise: reopen this draft in response to human feedback; never grants approval." })),
  text: Type.Optional(Type.String({ maxLength: 100000, description: "Complete Markdown for design, or human feedback for revise." })),
  revision: Type.Optional(Type.Integer({ minimum: 1, description: "For approve_design: the published revision implementing the human's approved changes. Requires recorded approval from their chat input; never grants execution permission." })),
});

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

export default function pairExtension(pi: ExtensionAPI) {
  let state: PairState | undefined;
  let recoveryError: string | undefined;
  let discussionOnly = false;
  let addedInvestigationTools: string[] = [];
  let lastContext: string | undefined;
  let liveContext: ExtensionContext | undefined;
  let queuedHumanTurns: string[] = [];
  const bridge = new PairReviewBridge();
  let chatApproval: { root: string; path: string; baseRevision: number; baseText: string; humanText: string; ready: boolean; published?: { revision: number; text: string } } | undefined;
  const permissions = registerStepPermissions(pi, { active, bridge, changed: (ctx, changes) => {
    // Shell actions can modify files too. Conservatively require a fresh report
    // after any approved execution, including a check with a new result.
    if (state?.active && changes?.length) {
      const memory = normalizeMemory(state.memory);
      const nextMemory = markCheckpointStale(memory);
      if (nextMemory !== memory) commit({ ...state, memory: nextMemory }, ctx);
    }
    // Separate steps never accept or replace the saved implementation review.
    if (!state?.active || !state.increment || !Object.keys(state.increment.expected).length) return;
    try {
      if (!changedSinceObservation(state.root, state.increment).length) return;
      commit({ ...state, phase: "paused", pauseReason: "Files changed in a separately approved step. The saved baseline remains available; earlier verification is stale.",
        increment: { ...observeFiles(state.root, state.increment), approvedRevision: undefined, summary: undefined, checks: undefined, deviations: undefined },
      }, ctx);
    } catch (error) { pause(`Saved review needs attention: ${String(error)}`, ctx); }
  } });

  bridge.setMemoryHandlers({
    read: (root) => state?.active && !recoveryError && state.root === root ? normalizeMemory(state.memory) : undefined,
    change: (root, mutation) => {
      if (!liveContext || state?.root !== root) throw new Error("The Pair task changed. Refresh its checkpoint.");
      return changeConstraint(liveContext, mutation);
    },
  });

  function changeConstraint(ctx: ExtensionContext, mutation: MemoryMutation): WorkMemory {
    const current = active(ctx);
    const memory = normalizeMemory(current.memory);
    if (mutation.revision !== memory.revision) throw new Error("The checkpoint changed. Refresh before editing constraints.");
    const next = mutation.action === "add_constraint" ? addConstraint(memory, mutation.text, mutation.scope, !ctx.isIdle()) : removeConstraint(memory, mutation.id);
    if (next === memory) return memory;
    // A human instruction can invalidate a reviewed proposal; it cannot approve it.
    permissions.constraintsChanged();
    commit({ ...current, memory: next }, ctx);
    if (ctx.hasUI) ctx.ui.notify("Constraint saved. Any pending review was cancelled; ask Pi to continue when ready.", "info");
    return next;
  }

  function configureInvestigationTools(enabled: boolean) {
    const selected = pi.getActiveTools();
    if (enabled) {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const additions = ["read", "grep", "find", "ls"].filter((name) => available.has(name) && !selected.includes(name));
      if (additions.length) {
        addedInvestigationTools.push(...additions);
        pi.setActiveTools([...selected, ...additions]);
      }
    } else if (addedInvestigationTools.length) {
      pi.setActiveTools(selected.filter((name) => !addedInvestigationTools.includes(name)));
      addedInvestigationTools = [];
    }
  }

  function commit(next: PairState, ctx: ExtensionContext) {
    // Persist a complete snapshot before exposing the transition to tools or UI.
    pi.appendEntry(STATE_ENTRY, structuredClone(next));
    state = next;
    liveContext = ctx;
    bridge.touchMemory();
    configureInvestigationTools(next.active);
    updateWidget(ctx, state);
  }

  function active(ctx: ExtensionContext): PairState {
    if (recoveryError) throw new Error(recoveryError);
    if (!state?.active) throw new Error("Start pairing with /pair first.");
    if (projectRoot(ctx.cwd) !== state.root) throw new Error("Pair belongs to another project. Start a new pairing session here.");
    return state;
  }

  function pause(reason: string, ctx: ExtensionContext) {
    const current = active(ctx);
    commit({ ...current, phase: "paused", pauseReason: reason }, ctx);
  }

  function matchesChatApproval(current: PairState): boolean {
    if (!chatApproval || chatApproval.root !== current.root || chatApproval.path !== current.design.path) return false;
    const expected = chatApproval.published ?? { revision: chatApproval.baseRevision, text: chatApproval.baseText };
    return expected.revision === current.design.revision && expected.text === current.design.text;
  }

  function recordDesignApproval(ctx: ExtensionContext, revision: number) {
    const current = active(ctx);
    if (!current.design.path || revision !== current.design.revision) throw new Error("The design revision changed. Review the current design before approving it.");
    if (snapshot(current.root, current.design.path).text !== current.design.text) throw new Error("The design changed on disk. Reconcile it before recording approval.");
    if (current.design.approvedRevision === revision) return;
    if (current.phase !== "design-approval") throw new Error("Publish the design before recording approval.");
    commit({ ...current, phase: "proposal", pauseReason: undefined, design: { ...current.design, approvedRevision: revision } }, ctx);
    chatApproval = undefined;
  }

  function advanceHumanTurn(ctx: ExtensionContext) {
    if (!state?.active || recoveryError || state.root !== projectRoot(ctx.cwd)) return;
    const memory = normalizeMemory(state.memory);
    const nextMemory = expireTurnConstraints(memory);
    if (nextMemory !== memory) commit({ ...state, memory: nextMemory }, ctx);
  }

  // This is the only hook with input provenance. Model output, tool results and
  // extension-generated user messages cannot authorize a design approval.
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    liveContext = ctx;
    if (event.streamingBehavior) queuedHumanTurns.push(event.text);
    else advanceHumanTurn(ctx);
    chatApproval = undefined;
    if (!state?.active || recoveryError || !state.design.path || !state.design.revision) return { action: "continue" };
    const approval = classifyDesignApproval(event.text);
    if (!approval) return { action: "continue" };
    try {
      const current = active(ctx);
      if (approval.revision !== undefined && approval.revision !== current.design.revision) throw new Error(`Chat approval refers to revision ${approval.revision}; the current design is revision ${current.design.revision}.`);
      if (snapshot(current.root, current.design.path).text !== current.design.text) throw new Error("The design changed on disk. Reconcile it before recording chat approval.");
      if (approval.kind === "direct") {
        recordDesignApproval(ctx, current.design.revision);
        if (ctx.hasUI) ctx.ui.notify(`Design revision ${current.design.revision} approved from chat.`, "info");
      } else if (current.phase === "design-approval" || current.design.approvedRevision === current.design.revision) {
        chatApproval = { root: current.root, path: current.design.path, baseRevision: current.design.revision, baseText: current.design.text,
          humanText: event.text, ready: !event.streamingBehavior };
      }
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
    return { action: "continue" };
  });

  pi.on("message_start", (event, ctx) => {
    // Queued input must actually reach the agent before an in-flight proposal
    // can claim it implements that feedback. Provenance was captured at input.
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const queued = queuedHumanTurns.indexOf(text);
    if (queued >= 0) { queuedHumanTurns.splice(queued, 1); advanceHumanTurn(ctx); }
    if (!chatApproval || chatApproval.ready) return;
    if (text !== chatApproval.humanText) return;
    if (state && matchesChatApproval(state)) chatApproval.ready = true;
    else chatApproval = undefined;
  });

  function reopen(target: "design" | "increment", feedback: string, ctx: ExtensionContext, requestedPath?: string) {
    const current = active(ctx);
    if (target === "design") {
      const path = normalizedFile(current.root, requestedPath ?? (current.design.path || "docs/design/pair.md"));
      if (!path.endsWith(".md")) throw new Error("Choose a Markdown design path.");
      commit(reopenDesign({ ...current, design: { ...current.design, path } }, snapshot(current.root, path).text ?? ""), ctx);
      if (!matchesChatApproval(active(ctx))) chatApproval = undefined;
    } else {
      if (!current.increment) throw new Error("There is no increment to revise.");
      commit({ ...current, phase: "paused", pauseReason: feedback,
        increment: { ...current.increment, approvedRevision: undefined, summary: undefined, checks: undefined, deviations: undefined },
      }, ctx);
    }
  }

  function restore(ctx: ExtensionContext) {
    liveContext = ctx;
    lastContext = undefined;
    state = undefined;
    recoveryError = undefined;
    discussionOnly = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const candidate = entry.data as PairState | undefined;
      if (candidate?.version !== 1 || typeof candidate.active !== "boolean" || !candidate.design || !Array.isArray(candidate.progress)) {
        recoveryError = "Pair session data is unreadable. Use /pair off to disable it, or /pair new to start again.";
        state = undefined;
      } else {
        state = structuredClone(candidate);
        if (state.memory) state.memory = normalizeMemory(state.memory);
        recoveryError = undefined;
      }
    }
    if (state?.active) {
      try {
        active(ctx);
        if (state.phase === "implement" && state.increment) {
          const changed = changedSinceObservation(state.root, state.increment);
          if (changed.length) pause(`Working files changed since the last observed tool result: ${changed.join(", ")}. Review the diff before resuming.`, ctx);
        }
      } catch (error) {
        recoveryError = `Pair recovery needs attention: ${String(error)}`;
      }
    }
    configureInvestigationTools(Boolean(state?.active));
    updateWidget(ctx, state);
    bridge.touchMemory();
    if (recoveryError && ctx.hasUI) ctx.ui.notify(recoveryError, "error");
  }

  pi.on("session_start", (_event, ctx) => { queuedHumanTurns = []; chatApproval = undefined; restore(ctx); });
  pi.on("session_tree", (_event, ctx) => { queuedHumanTurns = []; chatApproval = undefined; restore(ctx); });
  pi.on("session_compact", (_event, ctx) => {
    const preserveDiscussion = discussionOnly;
    restore(ctx);
    discussionOnly = preserveDiscussion;
    if (!state || !matchesChatApproval(state)) chatApproval = undefined;
  });
  pi.on("session_shutdown", (_event, ctx) => { queuedHumanTurns = []; chatApproval = undefined; updateWidget(ctx, undefined); });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state?.active && !recoveryError) {
      if (state) {
        const content = "Pair permissions are disabled. Earlier Pair guidance and approval state are inactive; follow the current human request and normal tool permissions.";
        if (content !== lastContext) { lastContext = content; return { message: { customType: "pair-context", content, display: false } }; }
      }
      return;
    }
    if (recoveryError) return { message: { customType: "pair-context", content: recoveryError, display: false } };
    const current = active(ctx);
    discussionOnly = event.messageType === "user" && event.prompt.startsWith("Discussion only; preserve the current approval state");
    const content = conciseState(current) + (chatApproval?.ready ? "\nThe human approved the design with requested changes in this chat. Apply only those changes, publish once, then record that revision with pair_work approve_design. Do not ask for the same approval again." : "");
    const recovery = permissions.recoveryBrief();
    const message = content !== lastContext || recovery ? { customType: "pair-context", content: [content !== lastContext ? content : "", recovery].filter(Boolean).join("\n"), display: false } : undefined;
    lastContext = content;
    return { systemPrompt: withPairContract(event.systemPrompt), message };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!state?.active && !recoveryError) return;
    const block = (reason: string) => ({ block: true as const, reason: `Pair: ${reason}` });
    if (recoveryError) return block(recoveryError);
    try {
      active(ctx);
      if (ctx.mode !== "tui") return block("Step permissions require interactive terminal mode.");
      const checkpointOnly = event.toolName === "pair_work" && ["checkpoint", "status", "feedback"].includes((event.input as { action?: string }).action ?? "");
      if (discussionOnly && !["read", "grep", "find", "ls"].includes(event.toolName) && !checkpointOnly) {
        return block("This is an explanation-only discussion. Make no changes.");
      }
      return permissions.guard(event);
    } catch (error) { return block(String(error)); }
  });
  pi.registerTool<typeof Params, { phase: PairState["phase"]; markdown?: string; checkpoint?: number; feedback?: number }>({
    name: "pair_work",
    label: "Pair",
    description: "Read status, update a brief milestone checkpoint, answer section feedback, publish/revise an optional design, or record existing chat design approval. Metadata never changes human constraints or grants execution permission. Use pair_step for edits/commands.",
    parameters: Params,
    prepareArguments: preparePairArguments("pair_work", Params),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const current = active(ctx);
      if (params.action === "feedback") {
        if (!params.replies) throw new Error("Supply replies with threadId and concise Markdown text.");
        permissions.replyFeedback(ctx, params.replies);
        return { content: [{ type: "text", text: `Saved ${params.replies.length} section ${params.replies.length === 1 ? "answer" : "answers"}.` }], details: { phase: current.phase,
          feedback: params.replies.length, markdown: params.replies.map(reply => `**${reply.threadId}**\n\n${reply.text}`).join("\n\n"),
        } };
      } else if (params.action === "checkpoint") {
        if (!params.checkpoint) throw new Error("Supply the checkpoint fields that changed.");
        const previous = normalizeMemory(current.memory);
        const memory = updateCheckpoint(previous, params.checkpoint);
        if (memory !== previous) commit({ ...current, memory }, ctx);
      } else if (params.action === "approve_design") {
        if (params.revision === undefined) throw new Error("Supply the published design revision to approve.");
        if (current.design.approvedRevision !== params.revision && (!matchesChatApproval(current) || !chatApproval?.ready || chatApproval.published?.revision !== params.revision)) {
          throw new Error("No chat approval is recorded for this revision. Do not infer approval from earlier designs or quoted text.");
        }
        recordDesignApproval(ctx, params.revision);
      } else if (params.action === "revise") {
        if (!params.target) throw new Error("Choose target design or increment.");
        reopen(params.target, required(params.text, "Human revision feedback"), ctx, params.design_path);
      } else if (params.action === "design") {
        const path = normalizedFile(current.root, current.design.path || params.design_path || "docs/design/pair.md");
        if (!path.endsWith(".md")) throw new Error("Choose a Markdown design path.");
        const text = required(params.text, "Complete design") + "\n";
        const disk = snapshot(current.root, path);
        if ((disk.text ?? "") !== current.design.text) throw new Error("The design changed on disk. Read it, then use pair_work revise with target design to import and reconcile it before publishing.");
        if (path === current.design.path && text === current.design.text) {
          // Repeating a publication does not manufacture a new approval cycle.
          if (current.phase === "design") commit({ ...current, phase: "design-approval" }, ctx);
          // A requested "keep X unchanged" constraint may already be satisfied.
          if (matchesChatApproval(current) && chatApproval?.ready && !chatApproval.published) chatApproval.published = { revision: current.design.revision, text };
        } else {
          if (current.design.path && !["design", "design-approval"].includes(current.phase)) throw new Error("Use pair_work revise with target design and the human's feedback to reopen the draft first.");
          const scopedApproval = matchesChatApproval(current) && chatApproval?.ready && !chatApproval.published;
          saveDesign(current.root, path, text);
          commit({ ...current, phase: "design-approval", pauseReason: undefined, design: {
            path, text, revision: current.design.revision + 1,
          } }, ctx);
          if (scopedApproval && chatApproval) chatApproval.published = { revision: current.design.revision + 1, text };
          else chatApproval = undefined;
        }
      }
      const next = active(ctx);
      const receipt = pairWorkResult(next, params.action, params.target) + (params.action === "status" && permissions.feedbackBrief() ? "\n" + permissions.feedbackBrief() : "") + (params.action === "design" && chatApproval?.published
        ? `\nChat approval is available for this requested revision. Record it with approve_design, revision ${next.design.revision}.` : "");
      const markdown = params.action === "design" ? next.design.text : params.action === "checkpoint" ? compactMemory(normalizeMemory(next.memory)) : receipt;
      return { content: [{ type: "text", text: receipt }], details: { phase: next.phase, markdown,
        ...(params.action === "checkpoint" ? { checkpoint: next.memory?.checkpoint?.revision } : {}),
      } };
    },
    renderShell: "self",
    renderCall(args, theme) {
      return new Text(theme.fg("accent", "Pair · " + plain(args.action ?? "working")), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Updating Pair…"), 0, 0);
      if (context.isError || !result.details) return new Text(result.content.filter((item) => item.type === "text").map((item) => plain(item.text)).join("\n"), 0, 0);
      // Older session entries have phase only; keep their saved tool results renderable.
      if (expanded) return new Markdown(plain(result.details.markdown ?? "Saved Pair status. Open /pair to read the current design and increment."), 0, 0, getMarkdownTheme());
      if (result.details.checkpoint !== undefined) return new Text(theme.fg("accent", `Checkpoint ${result.details.checkpoint} saved`) + theme.fg("muted", " · /pair checkpoint"), 0, 0);
      if (result.details.feedback !== undefined) return new Text(theme.fg("accent", `${result.details.feedback} section answers saved`) + theme.fg("muted", " · Review Desk"), 0, 0);
      return new Text(theme.fg("accent", phaseLabels[result.details.phase]) + theme.fg("muted", " · /pair to read and review"), 0, 0);
    },
  });

  async function start(ctx: ExtensionCommandContext) {
    if (state?.active || recoveryError) {
      if (!await ctx.ui.confirm("Start new pairing work?", "This replaces the active pairing state. Existing working files are retained.")) return;
    }
    const mode = await ctx.ui.select("Pair", ["Step permissions only", "Start design", "Use existing design"]);
    if (!mode) return;
    if (mode === "Step permissions only") { permissions.resetReviews(ctx); await bridge.close(); queuedHumanTurns = []; chatApproval = undefined; enable(ctx, true); return; }
    const goal = await ctx.ui.input("What are we working on?");
    if (!goal?.trim()) return;
    const root = projectRoot(ctx.cwd);
    const requested = await ctx.ui.input("Shared design file (relative to project)", "docs/design/pair.md");
    if (!requested?.trim()) return;
    const path = normalizedFile(root, requested.trim());
    if (!path.endsWith(".md")) throw new Error("Choose a Markdown design file.");
    const existing = snapshot(root, path);
    if (mode === "Use existing design" && !existing.exists) throw new Error("That design file does not exist.");
    const text = existing.text ?? "";
    const next: PairState = {
      version: 1, root, active: true, goal: goal.trim(), phase: existing.exists ? "design-approval" : "design",
      design: { path, text, revision: existing.exists ? 1 : 0 }, progress: [],
    };
    recoveryError = undefined;
    chatApproval = undefined;
    permissions.resetReviews(ctx);
    await bridge.close();
    queuedHumanTurns = [];
    commit(next, ctx);
    pi.sendUserMessage(`Investigate and discuss this goal: ${goal}. Follow collaborative-design, read ${path} if it exists, and publish a compact design with pair_work when ready. Do not implement during this design discussion.`);
  }

  function enable(ctx: ExtensionCommandContext, newTask = false) {
    if (state && !newTask && !recoveryError && state.root === projectRoot(ctx.cwd)) commit({ ...state, active: true }, ctx);
    else {
      recoveryError = undefined;
      commit({ version: 1, root: projectRoot(ctx.cwd), active: true, goal: "Pair programming", phase: "proposal",
        design: { path: "", text: "", revision: 0 }, progress: [],
      }, ctx);
    }
    ctx.ui.notify("Pair is on. Related file edits share one review with Approve all, Deny, or Deny with note. Routine Git setup runs directly.", "info");
  }

  async function approve(ctx: ExtensionCommandContext, confirmed = false): Promise<void> {
    const current = active(ctx);
    if (current.design.path && current.design.approvedRevision === current.design.revision) {
      recordDesignApproval(ctx, current.design.revision);
      ctx.ui.notify(`Design revision ${current.design.revision} is already approved.`, "info");
      return;
    }
    if (current.phase !== "design-approval") throw new Error("Steps now request permission in place through pair_step. Saved increment approval is no longer needed; ask the agent for the next explained step.");
    if (!confirmed) {
      const selected = await showPanel(ctx, current, "Open /pair Review for the current diff.", true);
      return await handlePanelAction(selected, ctx, current);
    }
    if (current.phase === "design-approval") {
      recordDesignApproval(ctx, current.design.revision);
      pi.sendUserMessage("The displayed design is approved. Start with the smallest understandable step. Use pair_step to explain the exact edit and request permission; do not batch the implementation into an increment.");
    }
  }

  async function revise(ctx: ExtensionCommandContext, view?: PanelView) {
    const current = active(ctx);
    const choice = view ? (view === "design" || !current.increment ? "Design" : "Current increment")
      : await ctx.ui.select("What needs revision?", current.increment ? ["Current increment", "Design"] : ["Design"]);
    if (!choice) return;
    const feedback = await ctx.ui.editor("Explain the requested revision");
    if (!feedback?.trim()) return;
    reopen(choice === "Design" ? "design" : "increment", feedback.trim(), ctx);
    pi.sendUserMessage(choice === "Design" ? `Revise the design based on this feedback: ${feedback}\nPublish with pair_work and stop for review.`
      : `Review feedback: ${feedback}\nExplain the next small correction and use pair_step for its permission. Preserve partial work and do not create another increment proposal.`);
  }

  async function resume(ctx: ExtensionCommandContext) {
    ctx.ui.notify("Ask the agent to continue with the next explained step. Each step requests its own permission; the saved review stays available in /pair.", "info");
    return;
  }

  async function constraintAction(ctx: ExtensionCommandContext, action: "add" | "remove", displayed = normalizeMemory(active(ctx).memory), direct?: { text: string; scope: "task" | "turn" }) {
    if (action === "add") {
      const text = direct?.text ?? await ctx.ui.input("Pin an instruction for Pair (up to 300 characters)");
      if (!text?.trim()) return;
      const selected = direct?.scope ?? await ctx.ui.select("How long should this instruction apply?", ["This task — until /pair new or removed", "Current or next turn"]);
      if (!selected) return;
      const scope = selected === "turn" || selected === "Current or next turn" ? "turn" : "task";
      changeConstraint(ctx, { action: "add_constraint", revision: displayed.revision, text, scope });
    } else {
      if (!displayed.constraints.length) { ctx.ui.notify("No pinned constraints.", "info"); return; }
      const labels = displayed.constraints.map((item, i) => `${i + 1}. [${item.scope}] ${item.text}`);
      const selected = await ctx.ui.select("Remove which instruction?", labels);
      if (!selected) return;
      const item = displayed.constraints[labels.indexOf(selected)];
      if (item) changeConstraint(ctx, { action: "remove_constraint", revision: displayed.revision, id: item.id });
    }
  }

  async function checkpointPanel(ctx: ExtensionCommandContext) {
    const current = active(ctx);
    const memory = normalizeMemory(current.memory);
    const result = await showCheckpoint(ctx, memory, current.goal);
    if (result !== "close") await constraintAction(ctx, result, memory);
  }

  async function finishReview(ctx: ExtensionCommandContext) {
    const current = active(ctx);
    if (current.phase !== "review") throw new Error("There is no completed increment awaiting review.");
    if (snapshot(current.root, current.design.path).text !== current.design.text) {
      throw new Error("The design changed on disk. Use /pair revise to reconcile it before updating progress.");
    }
    const text = current.design.text.replace("Latest increment awaits human review.\n<!-- pair-progress:end -->", "Latest increment reviewed. Ready for the next proposal.\n<!-- pair-progress:end -->");
    saveDesign(current.root, current.design.path, text);
    commit({ ...current, phase: "proposal", pauseReason: undefined, design: { ...current.design, text } }, ctx);
    ctx.ui.notify("Saved review finished. Ask for the next explained step when ready.", "info");
  }

  async function handlePanelAction(selected: { action: string; view: PanelView }, ctx: ExtensionCommandContext, displayed: PairState): Promise<void> {
    if (selected.action === "close") return;
    if (state !== displayed || !ctx.isIdle()) throw new Error("Pair changed while the panel was open. Reopen /pair to review the current revision.");
    if (selected.action === "approve") await approve(ctx, true);
    else if (selected.action === "revise") await revise(ctx, selected.view);
    else if (selected.action === "resume") await resume(ctx);
    else if (selected.action === "finish") await finishReview(ctx);
    else if (selected.action === "discuss") {
      const question = await ctx.ui.editor(`Discuss the ${selected.view}`);
      if (question?.trim()) pi.sendUserMessage(`Discussion only; preserve the current approval state and make no edits for this question: ${question}`);
    }
  }

  pi.registerCommand("pair", {
    description: "Review steps, checkpoint, and constraints. Actions: checkpoint, constraint [task|turn] <text>, code, on, design, new, approve (design), revise, finish, off.",
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "tui") throw new Error("Pair's controls require Pi's interactive terminal mode.");
        const action = args.trim();
        const reader = (!action || ["design", "code", "checkpoint", "constraint"].includes(action) || action.startsWith("constraint ")) && state?.active;
        if (!reader && !ctx.isIdle()) throw new Error("Wait for the current run to finish before changing Pair settings. /pair can still open the review.");
        if (action === "off") {
          if (!await ctx.ui.confirm("Turn Pair off?", "Pair's workflow guards will be disabled. Working files are retained.")) return;
          permissions.invalidate();
          if (state) commit({ ...state, active: false }, ctx);
          else pi.appendEntry(STATE_ENTRY, { version: 1, active: false, root: projectRoot(ctx.cwd), goal: "", phase: "design", design: { path: "", text: "", revision: 0 }, progress: [] });
          recoveryError = undefined;
          chatApproval = undefined;
          configureInvestigationTools(false);
          updateWidget(ctx, undefined);
          return;
        }
        if (action === "on" || (!action && !state?.active && !recoveryError)) return enable(ctx);
        if (action === "code") return await permissions.openEditor(ctx);
        if (action === "checkpoint") return await checkpointPanel(ctx);
        if (action === "constraint") return await constraintAction(ctx, "add");
        if (action.startsWith("constraint ")) {
          const input = action.slice("constraint ".length);
          const match = input.match(/^(task|turn)\s+(.+)$/s);
          return await constraintAction(ctx, "add", undefined, { scope: match?.[1] === "turn" ? "turn" : "task", text: match?.[2] ?? input });
        }
        if (action === "new") return await start(ctx);
        if (action === "approve") return await approve(ctx);
        if (action === "revise") return await revise(ctx);
        if (action === "resume") return await resume(ctx);
        if (action === "finish") return await finishReview(ctx);
        if (action && action !== "design") throw new Error("Use /pair, or /pair checkpoint|constraint|code|design|on|new|approve|revise|resume|finish|off.");
        const current = active(ctx);
        if (!action && await permissions.review(ctx)) return;
        let diff: string;
        try { diff = reviewDiff(current.root, current.increment); }
        catch (error) { diff = `Diff unavailable: ${String(error)}`; }
        const selected = await showPanel(ctx, current, diff, false, !ctx.isIdle());
        await handlePanelAction(selected, ctx, current);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
