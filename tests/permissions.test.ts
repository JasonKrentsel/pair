import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { registerStepPermissions, routineCommand } from "../extensions/pair/permissions.ts";

test("routine Git flags are accepted but shell composition and mutation are not", () => {
  for(const command of ['git status --short --branch --untracked-files=all','git diff --check','git diff --stat -- "src/my file.ts"']) assert.equal(routineCommand(command),true,command);
  for(const command of ['git status; echo bad','git diff --output=README.md','git -c alias.status=!bad status','git commit -m x','git diff --no-index a b','git diff -- "$SECRET"']) assert.equal(routineCommand(command),false,command);
});

function fixture(decide: (changes: any[]) => any) {
  const root = mkdtempSync(join(tmpdir(), "pair-permissions-test-"));
  const handlers = new Map<string, Function[]>();
  let tool: any;
  const pi: any = { on(name: string, callback: Function) { handlers.set(name,[...(handlers.get(name)??[]),callback]); }, registerTool(t: any) {tool=t;}, appendEntry() {} };
  const events: string[] = [];
  let failAt = 0;
  const controller = registerStepPermissions(pi, {active:()=>({root}),changed() {},review:async (_ctx,_title,_why,changes)=>decide(changes)});
  const ctx: any = {hasUI:true,mode:"tui",tools:[{name:"write"},{name:"edit"}],sessionManager:{getBranch:()=>[]},
    executeTool:async (name: string,args: any) => {
      const guarded = controller.guard({toolName:name,input:args,parentToolCallId:"request"} as any);
      assert.equal(guarded,undefined);
      events.push(args.path);
      if (failAt && events.length === failAt) return {isError:true,result:{content:[{type:"text",text:"Scripted failure"}],isError:true}};
      const native = name === "write" ? createWriteTool(root) : createEditTool(root);
      const result = await native.execute("native",args);
      return {isError:Boolean(result.isError),result};
    }};
  const run = (changes: any[]) => tool.execute("request",{title:"One change",why:"Two dependent files",changes},new AbortController().signal,undefined,ctx);
  return {root,events,controller,run,tool,handlers,ctx,fail: (index:number)=>{failAt=index;},close:()=>rmSync(root,{recursive:true,force:true})};
}

test("denial applies nothing; a note permits only a fresh proposal", async () => {
  const f = fixture(()=>({action:"deny",note:"Keep the existing API"}));
  try {
    const result = await f.run([{tool:"write",path:"a.ts",content:"x"}]);
    assert.equal(result.details.status,"Denied");
    assert.equal(f.events.length,0);
    assert.ok(f.controller.guard({toolName:"write",input:{path:"a.ts",content:"x"}} as any)?.block);
    await assert.rejects(f.run([{tool:"write",path:"a.ts",content:"x"}]),/exact step was denied/);
  } finally { f.close(); }
});

test("approval executes exact reviewed files; snapshots never enter model content", async () => {
  const f = fixture((changes)=>{assert.equal(changes[0].after,"private-marker-739");return {action:"approve"};});
  try {
    const result = await f.run([{tool:"write",path:"a.ts",content:"private-marker-739"},{tool:"write",path:"b.ts",content:"b"}]);
    assert.equal(f.events.length,2);
    assert.equal(readFileSync(join(f.root,"a.ts"),"utf8"),"private-marker-739");
    assert.ok(!JSON.stringify(result.content).includes("private-marker-739"));
    assert.equal(result.details.changes[1].status,"Applied");
  } finally { f.close(); }
});

test("external modification while reviewing prevents every write", async () => {
  const f = fixture(()=>{writeFileSync(join(f.root,"a.ts"),"human change");return {action:"approve"};});
  try {
    writeFileSync(join(f.root,"a.ts"),"original");
    const result = await f.run([{tool:"write",path:"a.ts",content:"proposed"},{tool:"write",path:"b.ts",content:"b"}]);
    assert.equal(result.isError,true);
    assert.equal(f.events.length,0);
    assert.equal(readFileSync(join(f.root,"a.ts"),"utf8"),"human change");
  } finally { f.close(); }
});

test("partial failure stops remaining actions and keeps completed work", async () => {
  const f = fixture(()=>({action:"approve"}));
  try {
    f.fail(2);
    const result = await f.run(["a","b","c"].map(path=>({tool:"write",path:path+".ts",content:path})));
    assert.equal(result.isError,true);
    assert.equal(f.events.length,2);
    assert.equal(result.details.changes[0].status,"Applied");
    assert.match(result.details.changes[1].status,/Failed/);
    assert.equal(result.details.changes[2].status,"Not run — proposed");
    assert.equal(readFileSync(join(f.root,"a.ts"),"utf8"),"a");
  } finally { f.close(); }
});

test("compaction does not clear a denial within the same run", async () => {
  const f = fixture(()=>({action:"deny"}));
  try {
    await f.run([{tool:"write",path:"a.ts",content:"a"}]);
    for(const handler of f.handlers.get("session_compact")??[]) handler({},f.ctx);
    assert.ok(f.controller.guard({toolName:"pair_step",input:{}} as any)?.block);
    for(const handler of f.handlers.get("before_agent_start")??[]) handler({},f.ctx);
    assert.equal(f.controller.guard({toolName:"pair_step",input:{}} as any),undefined);
  } finally { f.close(); }
});
