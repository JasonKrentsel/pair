import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairReviewBridge } from "../extensions/pair/bridge.ts";
import { addConstraint, normalizeMemory, removeConstraint, updateCheckpoint } from "../extensions/pair/checkpoint.ts";

test("checkpoint transport preserves review identity and binds human constraint updates to revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "pair-checkpoint-http-"));
  const registryDir = join(root, "registry");
  const bridge = new PairReviewBridge({ registryDir });
  let memory = updateCheckpoint(normalizeMemory(undefined), { objective: "Make recovery understandable", implemented: "Checkpoint writes", verification: "Scripted tests passed", usable: "Internal API only", deferred: "CLI integration", next: "Resume by ID" });
  let decisions = 0;
  bridge.setMemoryHandlers({ read: project => project === root ? memory : undefined, change(project, action) {
    assert.equal(project, root);
    if (action.revision !== memory.revision) throw new Error("The checkpoint changed. Refresh first.");
    memory = action.action === "add_constraint" ? addConstraint(memory, action.text, action.scope) : removeConstraint(memory, action.id);
    bridge.cancel();
    return memory;
  } });
  try {
    await bridge.start(root);
    const registry = JSON.parse(readFileSync(join(registryDir, readdirSync(registryDir)[0]), "utf8"));
    const endpoint = `http://127.0.0.1:${registry.port}`;
    const headers = { authorization: `Bearer ${registry.token}`, "content-type": "application/json" };
    const post = (value: unknown, extra: Record<string, string> = {}) => fetch(endpoint + "/memory", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    const proposed = bridge.publish({ title: "A change", why: "Review it", changes: [{ label: "src/a.ts", kind: "Edit", before: "a", after: "b", added: 1, removed: 1 }] }, () => { decisions++; });
    const first = await fetch(endpoint + "/review", { headers });
    assert.deepEqual((await first.json() as any).memory, memory);
    const etag = first.headers.get("etag")!;
    memory = updateCheckpoint(memory, { next: "Explain the resume boundary" });
    bridge.touchMemory();
    const refreshed = await fetch(endpoint + "/review", { headers: { ...headers, "if-none-match": etag } });
    assert.equal(refreshed.status, 200);
    const wire = await refreshed.json() as any;
    assert.equal(wire.review.fingerprint, proposed.fingerprint);
    assert.equal(wire.review.pending, true, "reporting status does not settle permission");
    assert.equal(wire.memory.checkpoint.next, "Explain the resume boundary");
    assert.equal((await post({ revision: 0, action: "add_constraint", text: "No installation", scope: "task" })).status, 409);
    assert.equal((await post({ revision: memory.revision, action: "add_constraint", text: "No installation", scope: "task" }, { origin: "http://example.invalid" })).status, 401);
    const accepted = await post({ revision: memory.revision, action: "add_constraint", text: "No installation", scope: "task" });
    assert.equal(accepted.status, 200);
    assert.equal(memory.constraints[0].text, "No installation");
    assert.equal(bridge.current?.pending, false);
    assert.equal(decisions, 1, "a human instruction cancels the previous pending review");
    assert.equal(bridge.decide({ action: "approve" }), false);
    assert.equal((await post({ revision: memory.revision, action: "approve" })).status, 400);
    assert.equal((await post({ revision: memory.revision, action: "add_constraint", text: "limit", scope: "task", command: "execute" })).status, 400);
    const remove = await post({ revision: memory.revision, action: "remove_constraint", id: memory.constraints[0].id });
    assert.equal(remove.status, 200);
    assert.equal(memory.constraints.length, 0);
    assert.equal(decisions, 1, "removing constraints never grants execution");
  } finally { await bridge.close(); rmSync(root, { recursive: true, force: true }); }
});
