import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge, type BridgeReview } from "./bridge.ts";
import { showPermission, type ChangePreview, type PermissionDecision, type PermissionViewOptions } from "./ui.ts";

/** Both UIs decide the same live proposal; a revision retires the old Pi dialog. */
export async function reviewWithCompanion(
  bridge: PairReviewBridge | undefined, root: string, ctx: ExtensionContext,
  title: string, why: string, changes: ChangePreview[], signal: AbortSignal | undefined,
  options: PermissionViewOptions, validate: () => void, terminal = showPermission,
  metadata?: { onPublished?: (review: BridgeReview) => void },
): Promise<PermissionDecision> {
  if (!bridge) return terminal(ctx,title,why,changes,signal,options);
  if (signal?.aborted) return {action:"deny"};
  try { await bridge.start(root); }
  catch {
    if(signal?.aborted)return {action:"deny"}; validate();
    ctx.ui.notify("VS Code connection unavailable. Review this change in Pi.","warning");
    return terminal(ctx,title,why,changes,signal,options);
  }
  if(signal?.aborted)return {action:"deny"}; validate();
  let resolveDecision!:(decision:PermissionDecision)=>void;
  const remote=new Promise<PermissionDecision>(resolve=>{resolveDecision=resolve;});
  const published=bridge.publish({title,why,changes},decision=>resolveDecision(decision),validate);
  const gate=bridge.decisionVersion;
  const owns=()=>bridge.current?.id===published.id&&bridge.decisionVersion===gate;
  const abort=()=>{if(owns())bridge.cancel();resolveDecision({action:"deny"});};
  try { metadata?.onPublished?.(published); } catch(error){if(owns())bridge.cancel();throw error;}
  signal?.addEventListener("abort",abort,{once:true}); if(signal?.aborted)abort();
  try {
    while(owns()&&bridge.current?.pending) {
      const current=bridge.current!;
      const localAbort=new AbortController();
      let revise!:()=>void;
      const revision=new Promise<{kind:"revision"}>(resolve=>{revise=()=>{localAbort.abort();resolve({kind:"revision"});};});
      const unsubscribe=bridge.onPendingRevision(revise);
      const combined=signal?AbortSignal.any([signal,localAbort.signal]):localAbort.signal;
      let local:Promise<{kind:"local";decision:PermissionDecision}>;
      try { local=Promise.resolve(terminal(ctx,current.title,current.why,current.changes,combined,options)).then(decision=>({kind:"local" as const,decision})); }
      catch(error){unsubscribe();localAbort.abort();throw error;}
      try {
        const outcome=await Promise.race([remote.then(decision=>({kind:"remote" as const,decision})),revision,local]);
        if(outcome.kind==="remote")return outcome.decision;
        // A late result from a retired terminal can never approve the new revision.
        if(outcome.kind==="revision"||bridge.current?.revision!==current.revision) { const retired=await Promise.race([local.then(()=>undefined,()=>undefined),remote]); if(retired)return retired; continue; }
        if(!owns()||!bridge.current?.pending)return await remote;
        try {bridge.decide(outcome.decision);} catch {if(owns())bridge.update("Stale — request a fresh review");}
        return outcome.decision;
      } finally {unsubscribe();localAbort.abort();void local.catch(()=>{});}
    }
    return await remote;
  } catch(error){if(owns())bridge.cancel();throw error;}
  finally{signal?.removeEventListener("abort",abort);}
}
