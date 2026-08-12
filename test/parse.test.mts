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
  const { nodes, links } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });

  const byId = new Map(nodes.map(n => [n.id, n]));
  assert.equal(byId.get("a.ts")?.status, "modified");
  assert.equal(byId.get("b.ts")?.status, "added");

  const importLink = links.find(l => l._linkType === "import" && l.source === "b.ts" && l.target === "a.ts");
  assert.ok(importLink, "expected an import edge from b.ts to a.ts");
});

test("parsePr detects a symbol-level call edge across files", () => {
  const { links } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1" });
  const callLink = links.find(l => l._linkType === "call" && l.sourceFile === "b.ts" && l.targetFile === "a.ts");
  assert.ok(callLink, "expected a call edge from b.ts's useIt() to a.ts's base()");
});

test("parsePr respects exclude filters", () => {
  const { nodes } = parsePr({ repoPath, prRef: "HEAD", baseRef: "HEAD~1", exclude: ["b.ts"] });
  assert.ok(!nodes.some(n => n.id === "b.ts"));
});
