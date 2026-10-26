import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIR_CONTRACT, conciseState, normalizeStepArguments, withPairContract } from "../extensions/pair/context.ts";

test("Pair guidance is stable and not appended twice", () => {
  const first = withPairContract("Host instructions");
  assert.equal(withPairContract(first), first);
  assert.equal(withPairContract("Host instructions"), first);
  assert.ok(PAIR_CONTRACT.length < 1600);
});

test("dynamic state contains facts without the full implementation skill", () => {
  const state: any = { goal: "Readable reviews", design: {path:"",revision:0}, progress: [] };
  const content = conciseState(state);
  assert.ok(content.includes("Readable reviews"));
  assert.ok(content.length < 200);
  assert.ok(!content.includes("pair_step"));
});

test("legacy single changes normalize before schema validation", () => {
  const change = {tool:"write",path:"a.ts",content:"x"};
  assert.deepEqual(normalizeStepArguments({title:"A",why:"B",change}), {title:"A",why:"B",changes:[change]});
  assert.throws(() => normalizeStepArguments({change,changes:[change]}), /not both/);
});
