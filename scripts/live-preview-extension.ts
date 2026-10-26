import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showPermission } from "../extensions/pair/ui.ts";
import { fixtures } from "./fixtures.ts";
export default function preview(pi: ExtensionAPI) {
  pi.registerCommand("pair-preview",{description:"Synthetic Pair review; no model or project changes",handler:async(args,ctx)=>{
    const name=args.trim()||"multi";
    const f=fixtures[name];
    if(!f){ctx.ui.notify(`Fixtures: ${Object.keys(fixtures).join(", ")}`,"info");return;}
    const decision=await showPermission(ctx,f.title,f.why,f.changes,undefined,{readOnly:f.readOnly});
    ctx.ui.notify(`Preview result: ${JSON.stringify(decision)}`,"info");
  }});
}
