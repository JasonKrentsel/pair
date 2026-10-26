import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge, type BridgeReview } from "./bridge.ts";
import { showPermission, type ChangePreview, type PermissionDecision, type PermissionViewOptions } from "./ui.ts";

/** One decision gate shared by both interfaces. UI events never become model messages. */
export async function reviewWithCompanion(
  bridge: PairReviewBridge | undefined, root: string, ctx: ExtensionContext,
  title: string, why: string, changes: ChangePreview[], signal: AbortSignal | undefined,
  options: PermissionViewOptions, validate: () => void, terminal = showPermission,
  metadata?: { onPublished?: (review: BridgeReview) => void },
): Promise<PermissionDecision> {
  if (!bridge) return terminal(ctx, title, why, changes, signal, options);
  if (signal?.aborted) return { action: "deny" };
  try { await bridge.start(root); }
  catch {
    if (signal?.aborted) return { action: "deny" };
    validate();
    ctx.ui.notify("VS Code connection unavailable. Review this change in Pi.", "warning");
    return terminal(ctx, title, why, changes, signal, options);
  }
  if (signal?.aborted) return { action: "deny" };
  // Starting the local listener is asynchronous: the session or the files may
  // have changed while it opened. Do not publish an obsolete approval gate.
  validate();
  const closeTerminal = new AbortController();
  let resolveDecision!: (decision: PermissionDecision) => void;
  let resolvedDecision: PermissionDecision | undefined;
  const remote = new Promise<PermissionDecision>((resolve) => { resolveDecision = resolve; });
  const onDecision = (decision: PermissionDecision) => {
    resolvedDecision = decision;
    resolveDecision(decision);
    closeTerminal.abort();
  };
  const published = bridge.publish({ title, why, changes }, onDecision, validate);
  const gate = bridge.decisionVersion;
  try { metadata?.onPublished?.(published); }
  catch (error) { if (bridge.current?.id === published.id) bridge.cancel(); throw error; }
  const ownsReview = () => bridge.current?.id === published.id && bridge.decisionVersion === gate;
  const abort = () => {
    if (ownsReview()) bridge.cancel();
    resolveDecision({ action: "deny" });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const combined = signal ? AbortSignal.any([signal, closeTerminal.signal]) : closeTerminal.signal;
  try {
    const local = terminal(ctx, title, why, changes, combined, options).then((decision) => {
      // A terminal may finish disposing after remote approval has already
      // started the next review. Its late result belongs only to this request.
      if (!ownsReview() || !bridge.current?.pending) return resolvedDecision ?? { action: "deny" as const };
      try { bridge.decide(decision); }
      catch {
        // The execution loop reports the stale-file failure using its ordinary
        // per-file result. Closing the dialog can never leave a live remote gate.
        if (ownsReview()) bridge.update("Stale — request a fresh review");
      }
      return decision;
    });
    return await Promise.race([remote, local]);
  } catch (error) {
    if (ownsReview()) bridge.cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    closeTerminal.abort();
  }
}
