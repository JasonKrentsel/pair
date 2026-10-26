import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { PairReviewBridge, type BridgeReview } from "../extensions/pair/bridge.ts";
import { registerStepPermissions } from "../extensions/pair/permissions.ts";
import type { ActionScope, ActionSession, ActionSessionResult } from "../extensions/pair/action-session.ts";

const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 500; i++) { const value = await read(); if (value) return value as NonNullable<T>; await wait(); }
  throw new Error("Timed out: " + label);
}
const identity = (review: BridgeReview) => ({ reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, gate: review.gate });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

async function fixture(respond: (text: string, options: Parameters<ActionSession["ask"]>[1], scope: ActionScope) => Promise<ActionSessionResult>, onUpdate?: (value: any) => void, onCreate?: (ctx: any) => void) {
  const root = mkdtempSync(join(tmpdir(), "pair-action-conversations-")), registryDir = join(root, "registry");
  const bridge = new PairReviewBridge({ registryDir }); await bridge.start(root);
  const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
  const headers = { authorization: "Bearer " + registry.token, "content-type": "application/json" };
  const url = "http://127.0.0.1:" + registry.port;
  const tools = new Map<string, any>(), entries: any[] = [], executions: any[] = [], opened: any[] = [], children: any[] = [];
  const pi: any = { on() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, appendEntry(customType: string, data: any) { entries.push({ customType, data }); } };
  const controller = registerStepPermissions(pi, { active: () => ({ root }), changed() {}, bridge,
    actionSessionFactory: (_ctx, toolCallId, scope) => {
      onCreate?.(_ctx);
      const child = { toolCallId, scope, disposed: false, calls: [] as string[] }; children.push(child);
      return { ask: async (text, options) => { child.calls.push(text); return respond(text, options, scope); }, dispose() { child.disposed = true; } };
    },
    review: async (_ctx, _title, _why, changes, signal) => {
      opened.push(structuredClone(changes));
      return new Promise(resolve => {
        // Even a late approval from the retired Pi dialog must be ignored.
        if (signal?.aborted) resolve({ action: "approve" }); else signal?.addEventListener("abort", () => resolve({ action: "approve" }), { once: true });
      });
    },
  });
  const ctx: any = { cwd: root, hasUI: true, mode: "tui", tools: ["write", "edit", "bash", "powershell"].map(name => ({ name })),
    sessionManager: { getBranch: () => [] }, ui: { notify() {} },
    executeTool: async (name: string, input: any, options: any) => {
      assert.equal(controller.guard({ toolName: name, input, parentToolCallId: "main-step" } as any), undefined);
      executions.push({ name, input: structuredClone(input) });
      if (name === "bash" || name === "powershell") return { isError: false, result: { content: [{ type: "text", text: "Scripted command completed." }] } };
      const result = await (name === "write" ? createWriteTool(root) : createEditTool(root)).execute("nested", input, options.signal);
      return { result, isError: Boolean(result.isError) };
    },
  };
  const original = "export const protocol = 'v1';\nexport function read() {\n  return 'before';\n}\n";
  writeFileSync(join(root, "a.ts"), original);
  const input = { title: "Create, check, and wire", why: "One ordered implementation step.", changes: [
    { tool: "write", path: "new.txt", content: "Unchanged sibling", why: "Create the source." },
    { tool: "powershell", command: "npm test", timeout: 30, why: "Check it before wiring." },
    { tool: "edit", path: "a.ts", edits: [{ oldText: "return 'before'", newText: "return 'proposed'" }], why: "Wire the implementation." },
  ] };
  const abort = new AbortController(); let settled = false, result: any, error: unknown;
  const running = tools.get("pair_step").execute("main-step", input, abort.signal, onUpdate, ctx).then((value: any) => { settled = true; result = value; }, (value: unknown) => { settled = true; error = value; });
  await until(() => bridge.current?.pending && opened.length, "pending main tool");
  const post = async (route: string, body: unknown) => {
    const response = await fetch(url + route, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const state = async () => { const response = await fetch(url + "/review", { headers }); assert.equal(response.status, 200); return await response.json() as any; };
  const open = async (index: number, scope: Record<string, number> = {}) => {
    const id = identity(bridge.current!); const response = await post("/conversation", { ...id, action: "open", index, ...scope }); assert.equal(response.status, 200, JSON.stringify(response.body));
    return { ...id, index, conversationId: response.body.conversationId };
  };
  return { root, original, bridge, post, state, open, children, executions, opened, abort, entries, ctx, get settled() { return settled; },
    async result() { await running; if (error) throw error; return result; },
    async close() { abort.abort(); await bridge.close(); await running; rmSync(root, { recursive: true, force: true }); },
  };
}

test("asking while parent awaits permission is streamed and idempotent without changing approval identity", async () => {
  const answer = deferred<ActionSessionResult>(); let updates: Parameters<ActionSession["ask"]>[1] | undefined;
  const f = await fixture(async (_text, options) => { updates = options; options.onUpdate?.("The function uses"); return answer.promise; });
  try {
    const before = f.bridge.current!, thread = await f.open(2, { startLine: 3, endLine: 3 });
    const send = { ...thread, action: "send", requestId: "question-1", mode: "ask", text: "Why does this preserve the protocol?" };
    assert.equal((await f.post("/conversation", send)).status, 200);
    assert.equal((await f.post("/conversation", send)).status, 200);
    const wire = await f.state(); assert.equal(wire.actionConversations[0].status, "running"); assert.match(wire.actionConversations[0].messages[1].text, /function uses/);
    assert.deepEqual(f.bridge.current, before); assert.equal(f.children[0].calls.length, 1); assert.equal(f.settled, false); assert.equal(f.executions.length, 0);
    assert.equal(f.children[0].scope.startLine, 3); assert.equal(f.children[0].toolCallId, "main-step");
    answer.resolve({ text: "Only the internal return changes; `protocol` stays v1." });
    await until(async () => (await f.state()).actionConversations[0].status === "ready", "question reply");
    assert.equal((await f.post("/conversation", send)).status, 200); assert.equal(f.children[0].calls.length, 1);
    assert.equal((await f.post("/conversation", { ...send, text: "Different text" })).status, 409);
    assert.equal((await f.post("/conversation", { ...send, requestId: "question-2", text: "Explain the return value." })).status, 200);
    await until(async () => (await f.state()).actionConversations[0].status === "ready", "second question reply");
    assert.equal(f.children[0].calls.length, 2);
    assert.equal((await f.post("/conversation", send)).status, 200);
    assert.equal(f.children[0].calls.length, 2, "a delayed retry of an older message must not create a third provider turn");
    assert.equal((await f.post("/conversation", { ...send, text: "Changed old message" })).status, 409);
    assert.deepEqual(f.bridge.current, before); assert.equal(updates?.signal?.aborted, false);
    assert.equal((await f.post("/decision", { ...identity(before), action: "deny" })).status, 200);
    await f.result(); assert.equal(f.children[0].disposed, true); assert.equal(f.executions.length, 0);
  } finally { answer.resolve({ text: "Done" }); await f.close(); }
});

test("Chat stays lazy until a valid Send and one fork handles explanations, revisions and follow-up questions", async () => {
  let branchReads = 0, promptReads = 0, providerCalls = 0;
  const f = await fixture(async (text, options) => {
    providerCalls++; assert.equal(options.mode, 'chat');
    return text.startsWith('Change') ? { text: 'Revise the internal return only.', candidate: { content: "  return 'revised';", summary: 'Keep the protocol and revise the internal return.' } }
      : { text: 'The protocol stays unchanged. Nothing has run.' };
  }, undefined, ctx => { ctx.sessionManager.getBranch(); ctx.getSystemPrompt(); });
  f.ctx.sessionManager.getBranch = () => { branchReads++; return []; };
  f.ctx.getSystemPrompt = () => { promptReads++; return 'Current effective parent prompt'; };
  try {
    const before = f.bridge.current!, thread = await f.open(2, { startLine: 3, endLine: 3 });
    assert.deepEqual(await f.open(2, { startLine: 3, endLine: 3 }), thread);
    await f.state(); await f.open(1);
    assert.equal(f.children.length, 0); assert.equal(branchReads, 0); assert.equal(promptReads, 0); assert.equal(providerCalls, 0);
    assert.equal((await f.post('/conversation', { ...thread, action: 'send', mode: 'chat', text: '  ', requestId: 'blank' })).status, 409);
    assert.equal(f.children.length, 0); assert.equal(branchReads, 0); assert.equal(promptReads, 0);
    const send = async (text: string, requestId: string) => {
      assert.equal((await f.post('/conversation', { ...thread, action: 'send', mode: 'chat', text, requestId })).status, 200);
      return until(async () => { const view = (await f.state()).actionConversations.find((item: any) => item.id === thread.conversationId); return view.status === 'ready' && view; }, 'chat reply');
    };
    assert.equal((await send('Why does this preserve the protocol?', 'why')).candidate, undefined);
    const candidate = (await send('Change only the return value.', 'change')).candidate;
    assert.ok(candidate); assert.equal((await send('Why is that better?', 'follow-up')).candidate.id, candidate.id);
    assert.equal(f.children.length, 1); assert.equal(branchReads, 1); assert.equal(promptReads, 1); assert.equal(providerCalls, 3);
    assert.deepEqual(f.bridge.current, before); assert.equal(f.executions.length, 0); assert.equal(f.settled, false);
    await f.post('/decision', { ...identity(before), action: 'deny' }); await f.result();
  } finally { await f.close(); }
});

test("using one selected-line revision updates the still-blocked step and rejects stale approvals", async () => {
  const f = await fixture(async (_text, options) => { assert.equal(options.mode, "revise"); return { text: "Use the preferred internal result.", candidate: { content: "  return 'revised';", summary: "Use the preferred internal result." } }; });
  try {
    const before = f.bridge.current!, thread = await f.open(2, { startLine: 3, endLine: 3 });
    assert.equal((await f.post("/conversation", { ...thread, action: "send", requestId: "adjust-1", mode: "adjust", text: "Change only the return value." })).status, 200);
    const candidate = await until(async () => (await f.state()).actionConversations[0].candidate, "candidate");
    assert.deepEqual(f.bridge.current, before); assert.equal(f.settled, false); assert.equal(f.executions.length, 0);
    assert.equal(existsSync(join(f.root, "new.txt")), false); assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), f.original);
    const adopted = await f.post("/conversation", { ...thread, action: "adopt", candidateId: candidate.id }); assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    const current = f.bridge.current!; assert.equal(current.id, before.id); assert.equal(current.revision, before.revision + 1); assert.equal(current.gate, (before.gate ?? 1) + 1); assert.notEqual(current.fingerprint, before.fingerprint);
    assert.deepEqual(current.changes.slice(0, 2), before.changes.slice(0, 2)); assert.match(current.changes[2].after!, /protocol = 'v1'/); assert.match(current.changes[2].after!, /return 'revised'/);
    await until(() => f.opened.length === 2, "refreshed Pi dialog"); assert.match(f.opened[1][2].after, /return 'revised'/);
    assert.equal(f.settled, false); assert.equal((await f.post("/decision", { ...identity(before), action: "approve" })).status, 409);
    assert.equal((await f.post("/decision", { ...identity(current), action: "approve" })).status, 200);
    const result = await f.result(); assert.equal(result.details.status, "Applied"); assert.deepEqual(f.executions.map(item => item.name), ["write", "powershell", "edit"]);
    assert.equal(readFileSync(join(f.root, "new.txt"), "utf8"), "Unchanged sibling"); assert.equal(f.executions[1].input.command, "npm test");
    assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), current.changes[2].after);
    assert.match(result.content[0].text, /original tool arguments were superseded/); assert.match(result.content[0].text, /return 'revised'/);
  } finally { await f.close(); }
});

test("command candidate preserves routing and a disk change in a sibling prevents adoption", async () => {
  const f = await fixture(async () => ({ text: "Use type checking.", candidate: { content: "npm run check", summary: "Use the focused check." } }));
  try {
    const before = f.bridge.current!, thread = await f.open(1);
    await f.post("/conversation", { ...thread, action: "send", requestId: "adjust-command", mode: "adjust", text: "Use the type check." });
    const candidate = await until(async () => (await f.state()).actionConversations[0].candidate, "command candidate");
    assert.equal(candidate.added, 1); assert.equal(candidate.removed, 1);
    assert.equal(candidate.preview.kind, "powershell"); assert.equal(candidate.preview.command, "npm run check");
    writeFileSync(join(f.root, "a.ts"), "human edit\n");
    const response = await f.post("/conversation", { ...thread, action: "adopt", candidateId: candidate.id }); assert.equal(response.status, 409); assert.match(response.body.error, /changed since the preview/);
    assert.deepEqual(f.bridge.current, before); assert.equal(f.settled, false); assert.equal(f.executions.length, 0);
    await f.post("/decision", { ...identity(before), action: "deny" }); await f.result();
    assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), "human edit\n");
  } finally { await f.close(); }
});

test("approval racing a child reply applies the current proposal and discards the late candidate", async () => {
  const answer = deferred<ActionSessionResult>(); let signal: AbortSignal | undefined;
  const f = await fixture(async (_text, options) => { signal = options.signal; return answer.promise; });
  try {
    const before = f.bridge.current!, thread = await f.open(2, { startLine: 3, endLine: 3 });
    await f.post("/conversation", { ...thread, action: "send", requestId: "racing-revision", mode: "adjust", text: "Change the return." });
    assert.equal((await f.post("/decision", { ...identity(before), action: "approve" })).status, 200);
    const result = await f.result(); assert.equal(result.details.status, "Applied"); assert.equal(signal?.aborted, true); assert.equal(f.children[0].disposed, true);
    answer.resolve({ text: "Late reply", candidate: { content: "  return 'late';", summary: "Late change." } }); await wait(15);
    const wire = await f.state(); assert.equal(wire.actionConversations[0].status, "closed"); assert.equal(wire.actionConversations[0].candidate, undefined);
    assert.match(readFileSync(join(f.root, "a.ts"), "utf8"), /return 'proposed'/); assert.doesNotMatch(result.content[0].text, /Human-adjusted/);
  } finally { answer.resolve({ text: "Done" }); await f.close(); }
});

test("stop and provider errors leave main approval available and allow a new focused request", async () => {
  const f = await fixture(async (text, options) => {
    if (text === "Fail") throw new Error("Scripted provider unavailable");
    if (text === "Wait") return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
    return { text: "The focused reply is ready." };
  });
  try {
    const before = f.bridge.current!, thread = await f.open(2);
    await f.post("/conversation", { ...thread, action: "send", requestId: "wait", mode: "ask", text: "Wait" });
    assert.equal((await f.post("/conversation", { ...thread, action: "stop" })).status, 200);
    await until(async () => (await f.state()).actionConversations[0].status === "ready", "stopped child");
    assert.deepEqual(f.bridge.current, before); assert.equal(f.settled, false);
    await f.post("/conversation", { ...thread, action: "send", requestId: "fail", mode: "ask", text: "Fail" });
    await until(async () => (await f.state()).actionConversations[0].status === "error", "provider error");
    assert.match((await f.state()).actionConversations[0].error, /provider unavailable/);
    await f.post("/conversation", { ...thread, action: "send", requestId: "retry", mode: "ask", text: "Try again" });
    await until(async () => (await f.state()).actionConversations[0].status === "ready", "retry answer");
    assert.deepEqual(f.bridge.current, before); assert.equal(f.executions.length, 0);
    await f.post("/decision", { ...identity(before), action: "deny" }); await f.result();
  } finally { await f.close(); }
});

test("bridge closure aborts child work and cannot leave the parent permission waiting", async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_text, options) => { signal = options.signal; return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("Closed")), { once: true })); });
  try {
    const thread = await f.open(2); await f.post("/conversation", { ...thread, action: "send", requestId: "disconnect", mode: "ask", text: "Explain this" });
    await f.bridge.close(); await until(() => f.settled, "parent permission cancellation"); await f.result();
    assert.equal(signal?.aborted, true); assert.equal(f.children[0].disposed, true); assert.equal(f.executions.length, 0); assert.equal(f.bridge.current, undefined);
    assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), f.original); assert.equal(existsSync(join(f.root, "new.txt")), false);
  } finally { await f.close(); }
});

test("failed replies retain activity and retry only the latest failed prompt without consuming another turn", async () => {
  let calls=0;
  const f=await fixture(async (_text,options)=>{
    calls++;
    options.onDetails?.({reasoning:'Compare the two database terms.',toolCalls:[{id:'one',name:'read',arguments:'{"path":"schema.py"}',status:'not-run'}],usage:{input:20,output:10,cacheRead:100}});
    if(calls===1)throw new Error('The reply was interrupted.');
    return {text:'DDL defines schema; a dialect is a SQL variant.'};
  });
  try {
    const before=f.bridge.current!,thread=await f.open(1);
    const send={...thread,action:'send',mode:'chat',text:'What is a DDL and a dialect?',requestId:'first'};
    await f.post('/conversation',send);
    await until(async()=>(await f.state()).actionConversations[0].status==='error','failed reply');
    const failed=(await f.state()).actionConversations[0].messages.at(-1);
    assert.match(failed.error,/interrupted/);assert.equal(failed.toolCalls[0].status,'not-run');assert.equal(failed.usage.cacheRead,100);
    assert.equal((await f.post('/conversation',{...send,requestId:'invalid-retry',retryMessageId:'wrong'})).status,409);
    const retry={...send,requestId:'retry',retryMessageId:failed.id};
    assert.equal((await f.post('/conversation',retry)).status,200);
    assert.equal((await f.post('/conversation',retry)).status,200);
    await until(async()=>(await f.state()).actionConversations[0].status==='ready','retried reply');
    const threadState=(await f.state()).actionConversations[0];
    assert.equal(threadState.messages.length,2);assert.equal(threadState.messages[1].error,undefined);
    assert.equal(threadState.messages[1].requestId,'retry');assert.equal(f.children.length,1);assert.equal(calls,2);
    assert.deepEqual(f.bridge.current,before);assert.equal(f.executions.length,0);
  } finally {await f.close();}
});


test("a failed progress renderer cannot separate executable actions from the visible approval identity", async () => {
  const f = await fixture(async () => ({ text: "Change the internal result.", candidate: { content: "  return 'revised';", summary: "Use the revised internal result." } }), value => {
    if (value.content?.[0]?.text === "Revision ready. Awaiting permission.") throw new Error("Scripted renderer failure");
  });
  try {
    const thread = await f.open(2, { startLine: 3, endLine: 3 });
    await f.post("/conversation", { ...thread, action: "send", requestId: "renderer-race", mode: "adjust", text: "Change the return value." });
    const candidate = await until(async () => (await f.state()).actionConversations[0].candidate, "candidate before renderer failure");
    await f.post("/conversation", { ...thread, action: "adopt", candidateId: candidate.id });
    const visible = f.bridge.current!;
    assert.equal(visible.pending, true);
    assert.equal((await f.post("/decision", { ...identity(visible), action: "approve" })).status, 200);
    await f.result();
    assert.equal(readFileSync(join(f.root, "a.ts"), "utf8"), visible.changes[2].after, "approval must execute exactly the proposal visible under that identity, even when progress rendering fails");
  } finally { await f.close(); }
});
