import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePr } from "../dist/index.mjs";

let repoPath: string;

function git(cmd: string) {
  return execSync(`git ${cmd}`, { cwd: repoPath, encoding: "utf8" });
}

before(() => {
  repoPath = mkdtempSync(join(tmpdir(), "dep-graph-core-test-"));
  git("init -q");
  git('config user.email "test@example.com"');
  git('config user.name "Test"');

  writeFileSync(join(repoPath, "a.ts"), `export function base() { return 1; }\n`);
  git("add a.ts");
  git('commit -q -m base');

  writeFileSync(join(repoPath, "a.ts"), `export function base() { return 2; }\n`);
  writeFileSync(join(repoPath, "b.ts"), `import { base } from "./a";\nexport function useIt() { return base(); }\n`);
  git("add a.ts b.ts");
  git('commit -q -m "add b.ts, change base()"');
});

after(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

test("parsePr detects added/modified files and import edges", () => {
  const { nodes, edges } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });

  const byId = new Map(nodes.map(n => [n.id, n]));
  assert.equal(byId.get("a.ts")?.status, "modified");
  assert.equal(byId.get("b.ts")?.status, "added");

  const importEdge = edges.find(e => e.type === "import" && e.src === "b.ts" && e.tar === "a.ts");
  assert.ok(importEdge, "expected an import edge from b.ts to a.ts");
});

test("parsePr flattens symbols into nodes with a parent pointing at their file", () => {
  const { nodes } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });

  const base = nodes.find(n => n.id === "a.ts:::base");
  assert.ok(base, "expected a flat node for a.ts's base() symbol");
  assert.equal(base?.type, "function");
  assert.equal(base?.parent, "a.ts");
  assert.equal(base?.status, "modified");

  const useIt = nodes.find(n => n.id === "b.ts:::useIt");
  assert.ok(useIt, "expected a flat node for b.ts's useIt() symbol");
  assert.equal(useIt?.parent, "b.ts");
  assert.equal(useIt?.status, "added");
});

test("parsePr detects a symbol-level call edge across files", () => {
  const { edges } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });
  const callEdge = edges.find(e => e.type === "call" && e.src === "b.ts:::useIt" && e.tar === "a.ts:::base");
  assert.ok(callEdge, "expected a call edge from b.ts's useIt() to a.ts's base()");
});

test("parsePr respects exclude filters", () => {
  const { nodes } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1", exclude: ["b.ts"] });
  assert.ok(!nodes.some(n => n.id === "b.ts"));
});

test("parsePr never puts a file endpoint on a call edge; unattributed named-import uses become reference edges", () => {
  const repo2 = mkdtempSync(join(tmpdir(), "dep-graph-core-test-"));
  const git2 = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo2, encoding: "utf8" });
  git2("init -q");
  git2('config user.email "test@example.com"');
  git2('config user.name "Test"');

  writeFileSync(join(repo2, "placeholder.ts"), `export const placeholder = 1;\n`);
  git2("add placeholder.ts");
  git2('commit -q -m base');

  // c.ts and d.ts both land in the same PR, so both are in the diff's file set.
  // Thing is used only in a type position — never called, never `new`'d.
  writeFileSync(join(repo2, "c.ts"), `export interface Thing { n: number }\n`);
  writeFileSync(join(repo2, "d.ts"), `import { Thing } from "./c";\nexport const x: Thing = { n: 1 };\n`);
  git2("add c.ts d.ts");
  git2('commit -q -m "add c.ts, d.ts"');

  const { edges } = parsePr({ repoPath: repo2, prRef: "HEAD", baseRef: "HEAD~1" });
  rmSync(repo2, { recursive: true, force: true });

  for (const e of edges) {
    if (e.type !== "call") continue;
    assert.ok(e.src.includes(":::"), `call edge source should be a symbol id, got ${e.src}`);
    assert.ok(e.tar.includes(":::"), `call edge target should be a symbol id, got ${e.tar}`);
  }

  const refEdge = edges.find(e => e.type === "reference" && e.src === "d.ts" && e.tar === "c.ts:::Thing");
  assert.ok(refEdge, "expected a file-level reference edge from d.ts to c.ts's Thing");
  assert.ok(!edges.some(e => e.type === "call" && e.tar === "c.ts:::Thing"), "Thing is never called/constructed, so no call edge should target it");
});
