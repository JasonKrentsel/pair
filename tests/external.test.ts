import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writeDiffSnapshots } from "../extensions/pair/external.ts";

test("editor snapshots preserve extensions and exact bytes without accepting edits back", () => {
  const root = mkdtempSync(join(tmpdir(), "pair-snapshot-test-"));
  try {
    const before = '\uFEFFconst a = 1;\r\n';
    const proposed = 'const a = 2;\n';
    const paths = writeDiffSnapshots("../../src/a.ts", before, proposed, root);
    assert.ok(!relative(root, paths.before).startsWith(".."));
    assert.ok(paths.after.endsWith("a.ts"));
    assert.equal(readFileSync(paths.before, "utf8"), before);
    assert.equal(readFileSync(paths.after, "utf8"), proposed);
    writeFileSync(paths.after, "changed in editor");
    assert.equal(proposed, "const a = 2;\n");
  } finally { rmSync(root, {recursive:true,force:true}); }
});
