import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PairReviewBridge, type BridgeDecision, type BridgeRegistry, type BridgeReview } from "../extensions/pair/bridge.ts";

const proposal = () => ({ title: "Extract the prompt", why: "Keep the prompt editable without changing its wording.", changes: [{ label: "src/agent.ts", kind: "Edit", before: "const x = 1;\n", after: "const x = 2;\n", added: 1, removed: 1 }] });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pair-bridge-test-"));
  const registryDir = join(directory, "registry");
  const bridge = new PairReviewBridge({ registryDir });
  await bridge.start(directory);
  const discovery = (): BridgeRegistry => JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
  const request = async (path: string, init: RequestInit = {}) => {
    const registry = discovery();
    return fetch(`http://127.0.0.1:${registry.port}${path}`, { ...init, headers: { authorization: "Bearer " + registry.token, ...init.headers } });
  };
  const post = (review: BridgeReview, fields: Record<string, unknown> = {}) => request("/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewId: review.id, revision: review.revision, fingerprint: review.fingerprint, action: "approve", ...fields }) });
  const close = async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); };
  return { directory, registryDir, bridge, discovery, request, post, close };
}

test("bridge registry identifies one local workspace and removes secrets at close", async () => {
  const f = await fixture();
  try {
    const entry = f.discovery();
    assert.equal(entry.root, f.directory);
    assert.equal(entry.version, 1);
    assert.equal(entry.pid, process.pid);
    assert.match(entry.token, /^[a-f\d]{64}$/);
    if (process.platform !== "win32") assert.equal(statSync(join(f.registryDir, entry.sessionId + ".json")).mode & 0o777, 0o600);
    await Promise.all([f.bridge.start(f.directory), f.bridge.start(f.directory)]);
    assert.deepEqual(f.discovery(), entry);
    assert.equal(readdirSync(f.registryDir).length, 1);
    const response = await f.request("/review");
    const data = await response.json();
    assert.equal(data.review, null);
    assert.equal(JSON.stringify(data).includes(entry.token), false);
    await f.bridge.close();
    assert.equal(readdirSync(f.registryDir).length, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${entry.port}/review`));
  } finally { await f.close(); }
});

test("all review endpoints require a bearer token and reject browser origins", async () => {
  const f = await fixture();
  try {
    for (const path of ["/review", "/status", "/decision"]) {
      const response = await f.request(path, { headers: { authorization: "" } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.equal((await f.request("/review", { headers: { origin: "http://localhost" } })).status, 401);
    assert.equal((await f.request("/decision", { method: "OPTIONS" })).status, 405);
    assert.equal((await f.request("/other")).status, 404);
  } finally { await f.close(); }
});

test("published snapshots are immutable and ETag avoids retransmitting unchanged files", async () => {
  const f = await fixture();
  try {
    const input = proposal();
    const published = f.bridge.publish(input, () => {});
    input.changes[0].after = "Changed caller input";
    published.changes[0].before = "Changed returned snapshot";
    const current = f.bridge.current!;
    current.changes[0].label = "mutated.ts";
    const response = await f.request("/review");
    const etag = response.headers.get("etag")!;
    const data = await response.json();
    assert.equal(data.review.changes[0].after, "const x = 2;\n");
    assert.equal(data.review.changes[0].before, "const x = 1;\n");
    assert.equal(data.review.changes[0].label, "src/agent.ts");
    assert.equal((await f.request("/review", { headers: { "if-none-match": etag } })).status, 304);
    const summary = await (await f.request("/status")).json();
    assert.equal(summary.review.id, data.review.id);
    assert.equal(summary.review.changes, undefined);
    f.bridge.update("Applying");
    assert.equal((await f.request("/review", { headers: { "if-none-match": etag } })).status, 200);
  } finally { await f.close(); }
});

test("HTTP and terminal decisions share an exact once gate", async () => {
  const f = await fixture();
  try {
    const decisions: BridgeDecision[] = [];
    const review = f.bridge.publish(proposal(), (decision) => decisions.push(decision));
    const responses = await Promise.all([f.post(review), f.post(review)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.deepEqual(decisions, [{ action: "approve" }]);
    assert.equal(f.bridge.decide({ action: "approve" }), false);
    assert.equal(f.bridge.current!.pending, false);
    assert.equal(f.bridge.current!.status, "Approved");
    const next = f.bridge.publish(proposal(), (decision) => decisions.push(decision));
    assert.equal(f.bridge.decide({ action: "deny", note: "Keep the API" }), true);
    assert.equal((await f.post(next)).status, 409);
    assert.deepEqual(decisions.at(-1), { action: "deny", note: "Keep the API" });
  } finally { await f.close(); }
});

test("wrong revision, fingerprint, old proposal, and cancelled proposals cannot approve", async () => {
  const f = await fixture();
  try {
    const decisions: BridgeDecision[] = [];
    const first = f.bridge.publish(proposal(), (decision) => decisions.push(decision));
    assert.equal((await f.post(first, { fingerprint: "wrong" })).status, 409);
    assert.equal((await f.post(first, { revision: 2 })).status, 409);
    const second = f.bridge.publish(proposal(), (decision) => decisions.push(decision));
    assert.equal((await f.post(first)).status, 409);
    assert.equal(f.bridge.current!.id, second.id);
    f.bridge.cancel();
    assert.equal(f.bridge.current!.status, "Cancelled");
    assert.equal((await f.post(second)).status, 409);
    assert.deepEqual(decisions, [{ action: "deny" }, { action: "deny" }]);
  } finally { await f.close(); }
});

test("approval revalidates live files; stale review can still be denied with a note", async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, "source.ts");
    writeFileSync(file, "before");
    const decisions: BridgeDecision[] = [];
    const review = f.bridge.publish(proposal(), (decision) => decisions.push(decision), () => {
      if (readFileSync(file, "utf8") !== "before") throw new Error("source.ts changed. Request a fresh preview.");
    });
    writeFileSync(file, "human edit");
    const response = await f.post(review);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed/);
    assert.equal(f.bridge.current!.pending, true);
    assert.equal(decisions.length, 0);
    const denial = await f.post(review, { action: "deny", note: "  Preserve my new edit.  " });
    assert.equal(denial.status, 200);
    assert.deepEqual(decisions, [{ action: "deny", note: "Preserve my new edit." }]);
    assert.equal(readFileSync(file, "utf8"), "human edit");
  } finally { await f.close(); }
});

test("disconnect does not resolve a pending review; new client can decide it", async () => {
  const f = await fixture();
  try {
    let count = 0;
    f.bridge.publish(proposal(), () => count++);
    const first = await (await f.request("/review")).json();
    const second = await (await f.request("/review")).json();
    assert.equal(second.review.id, first.review.id);
    assert.equal(second.review.pending, true);
    assert.equal(count, 0);
    assert.equal((await f.post(second.review)).status, 200);
    assert.equal(count, 1);
  } finally { await f.close(); }
});

test("malformed and oversized decisions cannot grant permission", async () => {
  const f = await fixture();
  try {
    let count = 0;
    const review = f.bridge.publish(proposal(), () => count++);
    for (const fields of [{ action: "run" }, { note: "approve with modifications" }, { action: "deny", note: "x".repeat(4001) }, { executable: "evil" }]) assert.equal((await f.post(review, fields)).status, 400);
    assert.equal((await f.request("/decision", { method: "POST", body: "{}" })).status, 400);
    assert.equal((await f.request("/decision", { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status, 400);
    assert.equal((await f.post(review, { action: "deny", note: "x".repeat(20_000) })).status, 413);
    assert.equal(count, 0);
    assert.equal(f.bridge.current!.pending, true);
  } finally { await f.close(); }
});

test("changing workspace retires the old registry and pending review", async () => {
  const f = await fixture();
  try {
    const old = f.discovery();
    const decisions: BridgeDecision[] = [];
    f.bridge.publish(proposal(), (decision) => decisions.push(decision));
    await f.bridge.start(join(f.directory, "another-project"));
    const fresh = f.discovery();
    assert.notEqual(fresh.sessionId, old.sessionId);
    assert.notEqual(fresh.token, old.token);
    assert.equal(fresh.root, join(f.directory, "another-project"));
    assert.equal(readdirSync(f.registryDir).length, 1);
    assert.equal(f.bridge.current, undefined);
    assert.deepEqual(decisions, [{ action: "deny" }]);
  } finally { await f.close(); }
});

test("status sealing and recorded outcomes cannot be approved; changed result snapshots get a fresh identity", async () => {
  const f = await fixture();
  try {
    let count = 0;
    const review = f.bridge.publish(proposal(), () => count++);
    f.bridge.update("Stale — request a fresh review");
    assert.equal(f.bridge.current!.pending, false);
    assert.equal((await f.post(review)).status, 409);
    assert.equal(count, 0);
    const changes = proposal().changes;
    changes[0].after = "Partial result";
    f.bridge.update("Failed", changes);
    assert.notEqual(f.bridge.current!.fingerprint, review.fingerprint);
    assert.equal(f.bridge.current!.revision, review.revision + 1);
    assert.equal(review.changes[0].after, "const x = 2;\n");
    const record = f.bridge.record({ ...proposal(), status: "Applied" });
    assert.equal(record.pending, false);
    assert.notEqual(record.id, review.id);
    assert.equal((await f.post(record)).status, 409);
    assert.equal(f.bridge.sessionId, f.discovery().sessionId);
  } finally { await f.close(); }
});

test("focus routing is atomic, changes polling state, and never changes or authorizes a snapshot", async () => {
  const f = await fixture();
  try {
    let decisions = 0;
    const input = proposal();
    input.changes.push({ ...input.changes[0], label: "src/other.ts" });
    const review = f.bridge.publish(input, () => decisions++);
    const response = await f.request("/review");
    const etag = response.headers.get("etag")!;
    f.bridge.requestFocus(1);
    const firstStamp = f.discovery().focusRequestedAt!;
    const focused = await f.request("/review", { headers: { "if-none-match": etag } });
    assert.equal(focused.status, 200);
    const payload = await focused.json();
    assert.equal(payload.focus.selected, 1);
    assert.deepEqual(payload.review, review);
    assert.equal(decisions, 0);
    assert.equal(f.bridge.current!.pending, true);
    assert.deepEqual(readdirSync(f.registryDir), [f.discovery().sessionId + ".json"]);
    f.bridge.requestFocus(0);
    assert.ok(f.discovery().focusRequestedAt! > firstStamp);
    const next = await (await f.request("/status")).json();
    assert.notEqual(next.focus.id, payload.focus.id);
    assert.equal(next.focus.selected, 0);
    assert.equal(next.review.changes, undefined);
    f.bridge.decide({ action: "deny" });
    const recorded = f.bridge.record({ ...input, status: "Applied" });
    f.bridge.requestFocus(1);
    assert.equal((await f.post(recorded)).status, 409);
    assert.equal(f.bridge.current!.fingerprint, recorded.fingerprint);
    assert.equal(f.bridge.current!.pending, false);
    assert.equal(decisions, 1);
  } finally { await f.close(); }
});

test("opening Pair before the first proposal focuses the connected empty view", async () => {
  const f = await fixture();
  try {
    const response = await f.request("/review");
    const etag = response.headers.get("etag")!;
    f.bridge.requestFocus(7);
    const focused = await f.request("/review", { headers: { "if-none-match": etag } });
    assert.equal(focused.status, 200);
    const data = await focused.json();
    assert.equal(data.review, null);
    assert.equal(data.focus.selected, 0);
    assert.ok(data.focus.id);
    assert.ok(f.discovery().focusRequestedAt);
    assert.equal(f.bridge.current, undefined);
    assert.equal(f.bridge.decide({ action: "approve" }), false);
  } finally { await f.close(); }
});

test("command progress is bounded and ephemeral without changing approval identity or feedback events", async () => {
 const f=await fixture();
 try {
  const r=f.bridge.publish({title:"Check",why:"Verify",changes:[{label:"check",kind:"bash",command:"npm run check",added:0,removed:0}]},()=>{});
  f.bridge.setCommandProgress(r.id,0,"Running","unapproved");
  assert.equal(f.bridge.progress.length,0);
  f.bridge.decide({action:"approve"});
  const before=f.bridge.current, feedback=f.bridge.feedback;
  const response=await f.request("/review"), etag=response.headers.get("etag")!;
  f.bridge.setCommandProgress(r.id,0,"Running","\x1b[31m"+"line\n".repeat(500)+"</script>");
  assert.equal(f.bridge.progress[0].truncated,true);
  assert.equal(f.bridge.progress[0].text.includes("\x1b"),false);
  assert.ok(f.bridge.progress[0].text.split("\n").length<=400);
  assert.deepEqual(f.bridge.current,before);
  assert.deepEqual(f.bridge.feedback,feedback);
  assert.equal((await f.request("/review",{headers:{"if-none-match":etag}})).status,200);
  f.bridge.publish(proposal(),()=>{});
  f.bridge.setCommandProgress(r.id,0,"Completed","late");
  assert.deepEqual(f.bridge.progress,[]);
 } finally {await f.close();}
});
