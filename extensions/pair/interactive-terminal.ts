import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PairReviewBridge } from "./bridge.ts";
import { outputTail } from "./command-output.ts";

export interface TerminalGrant { root: string; reviewId: string; index: number; shell: string; command: string; timeout?: number }
export function terminalShell(shell: string, command: string): { file: string; args: string[] } {
  if (shell === "powershell") {
    if (process.platform !== "win32") throw new Error("PowerShell interactive commands require Windows.");
    const modern = join(process.env.ProgramFiles || "C:/Program Files", "PowerShell/7/pwsh.exe");
    const legacy = join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    return { file: existsSync(modern) ? modern : legacy, args: ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(command,"utf16le").toString("base64")] };
  }
  const file = process.platform === "win32" ? join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe") : "/bin/bash";
  if (!existsSync(file)) throw new Error("Interactive Bash is unavailable. Install Bash or propose a PowerShell command.");
  return { file, args: ["-c",command] };
}
export function registerInteractiveTerminal(pi: ExtensionAPI, bridge: PairReviewBridge | undefined) {
  const grants = new Map<string,TerminalGrant>();
  pi.registerTool({ name:"pair_terminal", label:"Interactive command", exposure:"deferred", executionMode:"sequential",
    description:"Internal executor for a one-use approved Pair step; requires its private ticket.",
    parameters:Type.Object({ticket:Type.String(),command:Type.String(),shell:Type.String()}),
    async execute(_id,params,signal,onUpdate) {
      const grant=grants.get(params.ticket);grants.delete(params.ticket);
      if(!grant||grant.command!==params.command||grant.shell!==params.shell||!bridge||bridge.current?.id!==grant.reviewId||bridge.current.pending)throw new Error("This interactive command has no current approval.");
      signal?.throwIfAborted();
      const shell=terminalShell(grant.shell,grant.command);
      const node=/^node(?:\.exe)?$/i.test(basename(process.execPath))?process.execPath:process.platform==='win32'?join(process.env.ProgramFiles||'C:/Program Files','nodejs/node.exe'):'node';
      return await new Promise<AgentToolResult<{exitCode:number;raw:string}>>(resolve=>{
        const runId=randomUUID();let raw='',finished=false,reason:string|undefined,exitCode=-1,updateTimer:ReturnType<typeof setTimeout>|undefined;
        const child=fork(fileURLToPath(new URL('./pty-host.cjs',import.meta.url)),[],{execPath:node,execArgv:[],cwd:grant.root,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']} as import('node:child_process').ForkOptions & {windowsHide:boolean});
        const emit=()=>{updateTimer=undefined;onUpdate?.({content:[{type:'text',text:raw}],details:undefined});};
        const finish=()=>{
          if(finished)return;finished=true;clearTimeout(timeout);clearTimeout(killTimer);clearTimeout(updateTimer);signal?.removeEventListener('abort',abort);bridge.endTerminal(runId);
          const footer=reason||`Process exited with code ${exitCode}.`;
          resolve({isError:!!reason||exitCode!==0,content:[{type:'text',text:outputTail(raw).text+'\n'+footer}],details:{exitCode,raw:raw+'\r\n'+footer}});
        };
        const send=(message:unknown)=>{if(child.connected)child.send(message as any);};
        let killTimer:ReturnType<typeof setTimeout>|undefined;
        const stop=(why:string)=>{if(finished||reason)return;reason=why;bridge.endTerminal(runId);send({type:'stop',reason:why});killTimer=setTimeout(()=>{child.kill();},2500);};
        const abort=()=>stop('Interactive command interrupted. Remaining actions were not run.');
        const timeout=setTimeout(()=>stop('Interactive command timed out. Remaining actions were not run.'),(grant.timeout??300)*1000);
        child.on('message',(message:any)=>{
          if(finished)return;
          if(message.type==='data' && typeof message.text==='string'){raw+=message.text;if(raw.length>131072)raw=raw.slice(-65536);updateTimer??=setTimeout(emit,50);}
          else if(message.type==='ready'){
            if(reason){send({type:'stop',reason});return;}
            try{bridge.beginTerminal({reviewId:grant.reviewId,index:grant.index,runId,cols:120,rows:30},{input:text=>{send({type:'input',text});if(text.includes('\x03'))abort();},resize:(cols,rows)=>send({type:'resize',cols,rows}),stop:abort});}
            catch(error){stop(String(error));}
          }else if(message.type==='exit'){exitCode=message.code;if(message.reason&&!reason)reason=message.reason;}
        });
        child.stderr?.on('data',data=>{raw+=String(data);raw=raw.slice(-65536);});
        child.on('error',error=>{reason=String(error);finish();});
        child.on('exit',()=>{emit();finish();});
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();else send({type:'start',...shell,cwd:grant.root});
      });
    }
  });
  return {grant(value:TerminalGrant){const ticket=randomUUID();grants.set(ticket,value);return {ticket,command:value.command,shell:value.shell};},clear(){grants.clear();}};
}
