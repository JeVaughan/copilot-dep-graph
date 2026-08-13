import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePr } from "../dist/index.mjs";
import { diffSymbols, buildFileNodes, graphIdForQualifiedName } from "../dist/parse.mjs";

// ── Pure node-building logic (no git, no tree-sitter — hand-built Symbol fixtures) ──
// These exercise buildFileNodes/diffSymbols directly, covering container nesting
// (class methods) without paying for a real repo + parse round-trip.

test("graphIdForQualifiedName: chains a dot-joined qualified name into a ':::'-joined graph id", () => {
  assert.equal(graphIdForQualifiedName("a.ts", "run"), "a.ts:::run");
  assert.equal(graphIdForQualifiedName("a.ts", "Widget.run"), "a.ts:::Widget:::run");
});

test("buildFileNodes: a symbol with no parent sits directly under the file, as before", () => {
  const nodes = buildFileNodes("a.ts", "modified", [
    { name: "run", kind: "function", status: "added" },
  ]);
  assert.deepEqual(nodes.map(n => n.id), ["a.ts", "a.ts:::run"]);
  assert.equal(nodes[1].parent, "a.ts");
});

test("buildFileNodes: a symbol with a parent nests under its enclosing symbol's node, not the file", () => {
  const nodes = buildFileNodes("a.ts", "modified", [
    { name: "Widget", kind: "class", status: "unchanged" },
    { name: "run", kind: "method", parent: "Widget", status: "added" },
  ]);
  const run = nodes.find(n => n.id === "a.ts:::Widget:::run");
  assert.ok(run, "expected the method node nested under its class's graph id");
  assert.equal(run?.parent, "a.ts:::Widget");
});

test("buildFileNodes: same-named methods on different classes get distinct, correctly-parented ids", () => {
  const nodes = buildFileNodes("a.ts", "modified", [
    { name: "A", kind: "class", status: "unchanged" },
    { name: "B", kind: "class", status: "unchanged" },
    { name: "run", kind: "method", parent: "A", status: "added" },
    { name: "run", kind: "method", parent: "B", status: "unchanged" },
  ]);
  const ids = nodes.map(n => n.id);
  assert.ok(ids.includes("a.ts:::A:::run"));
  assert.ok(ids.includes("a.ts:::B:::run"));
  assert.equal(nodes.find(n => n.id === "a.ts:::A:::run")?.status, "added");
  assert.equal(nodes.find(n => n.id === "a.ts:::B:::run")?.status, "unchanged");
});

test("diffSymbols: matches by qualified name, so same-named methods on different classes diff independently", () => {
  const baseSyms = [
    { name: "run", kind: "method", parent: "A", body: "A.run v1" },
    { name: "run", kind: "method", parent: "B", body: "B.run v1" },
  ];
  const prSyms = [
    { name: "run", kind: "method", parent: "A", body: "A.run v2" }, // changed
    { name: "run", kind: "method", parent: "B", body: "B.run v1" }, // unchanged
  ];
  const diffed = diffSymbols(prSyms, baseSyms);
  assert.equal(diffed.find(s => s.parent === "A")?.status, "modified");
  assert.equal(diffed.find(s => s.parent === "B")?.status, "unchanged");
});

test("diffSymbols: flags a new symbol as added and a disappeared one as removed", () => {
  const diffed = diffSymbols(
    [{ name: "keep", kind: "function", body: "1" }, { name: "brand-new", kind: "function", body: "1" }],
    [{ name: "keep", kind: "function", body: "1" }, { name: "gone", kind: "function", body: "1" }],
  );
  assert.equal(diffed.find(s => s.name === "brand-new")?.status, "added");
  assert.equal(diffed.find(s => s.name === "gone")?.status, "removed");
  assert.equal(diffed.find(s => s.name === "keep")?.status, "unchanged");
});

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

test("parsePr passes refs containing shell-special characters (^) through untouched", () => {
  // git() uses spawnSync's argv array, bypassing the shell entirely, so "HEAD^" must
  // resolve exactly like "HEAD~1" — not have its "^" stripped/mangled (which is what
  // happened under the old execSync-based implementation on Windows' cmd.exe).
  const byCaret = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD^" });
  const byTilde = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });
  assert.deepEqual(byCaret.nodes, byTilde.nodes);
  assert.deepEqual(byCaret.edges, byTilde.edges);
});

test("parsePr falls back to the caller-supplied baseRef when the ref is already on origin/HEAD", () => {
  // merge-base(origin/HEAD, prRef) === prRef itself happens when prRef is already
  // merged/pushed to the remote's default branch — without the fallback this collapses
  // effectiveBase to prRef too, producing an empty diff.
  const bareDir = mkdtempSync(join(tmpdir(), "dep-graph-core-bare-"));
  execSync(`git init -q --bare "${bareDir}"`);

  const workDir = mkdtempSync(join(tmpdir(), "dep-graph-core-work-"));
  const gitWork = (cmd: string) => execSync(`git ${cmd}`, { cwd: workDir, encoding: "utf8" });
  gitWork("init -q");
  gitWork('config user.email "test@example.com"');
  gitWork('config user.name "Test"');
  gitWork(`remote add origin "${bareDir}"`);

  writeFileSync(join(workDir, "a.ts"), `export const a = 1;\n`);
  gitWork("add a.ts");
  gitWork('commit -q -m base');
  gitWork("push -q origin HEAD:main");

  writeFileSync(join(workDir, "a.ts"), `export const a = 2;\n`);
  gitWork("add a.ts");
  gitWork('commit -q -m "modify a"');
  gitWork("push -q origin HEAD:main");
  gitWork("fetch -q origin");
  // Point origin/HEAD at origin/main directly, same as a real clone would set up.
  gitWork("symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");

  try {
    const { nodes } = parsePr({ repoPath: workDir, prRef: "HEAD", baseRef: "HEAD~1" });
    const a = nodes.find(n => n.id === "a.ts");
    assert.ok(a, "expected a.ts to appear in the diff instead of an empty diff");
    assert.equal(a?.status, "modified");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
