import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitHubPr } from "../dist/github.mjs";
import { parsePr } from "../dist/index.mjs";

test("resolveGitHubPr fetches refs/pull/<n>/head and returns a ref parsePr can use directly", () => {
  // Simulates a real GitHub PR: the PR's head commit lives at refs/pull/<n>/head on the
  // remote, and main has since moved on (squash/rebase-merged) so the local checkout's
  // HEAD no longer has any ancestry relationship with the PR branch.
  const bareDir = mkdtempSync(join(tmpdir(), "dep-graph-core-bare-"));
  execSync(`git init -q --bare "${bareDir}"`);

  const prDir = mkdtempSync(join(tmpdir(), "dep-graph-core-prsrc-"));
  const gitPr = (cmd: string) => execSync(`git ${cmd}`, { cwd: prDir, encoding: "utf8" });
  gitPr("init -q");
  gitPr('config user.email "test@example.com"');
  gitPr('config user.name "Test"');
  gitPr(`remote add origin "${bareDir}"`);

  writeFileSync(join(prDir, "a.ts"), `export const a = 1;\n`);
  gitPr("add a.ts");
  gitPr('commit -q -m base');
  gitPr("push -q origin HEAD:main");

  gitPr("checkout -qb pr-branch");
  writeFileSync(join(prDir, "a.ts"), `export const a = 2;\n`);
  gitPr("add a.ts");
  gitPr('commit -q -m "modify a"');
  // GitHub exposes every PR's head commit as refs/pull/<n>/head on the remote.
  gitPr("push -q origin pr-branch:refs/pull/7/head");

  // Simulate the squash/rebase-merge landing on main with a brand new commit
  // (no shared history with pr-branch's commit at all).
  gitPr("checkout -q main");
  writeFileSync(join(prDir, "a.ts"), `export const a = 2;\n// squashed\n`);
  gitPr("add a.ts");
  gitPr('commit -q -m "squash-merge pr #7"');
  gitPr("push -q origin HEAD:main");

  // A separate local clone, standing in for the machine running dep-graph — its main
  // is behind the remote's squash-merge commit, same as a real stale checkout.
  const workDir = mkdtempSync(join(tmpdir(), "dep-graph-core-work-"));
  execSync(`git clone -q "${bareDir}" "${workDir}"`);
  const gitWork = (cmd: string) => execSync(`git ${cmd}`, { cwd: workDir, encoding: "utf8" });
  gitWork("checkout -q main");
  gitWork("reset -q --hard HEAD~1"); // roll local main back before the squash-merge

  try {
    const prRef = resolveGitHubPr(workDir, 7);
    assert.equal(prRef, "FETCH_HEAD");

    const { nodes } = parsePr({ repoPath: workDir, prRef });
    const a = nodes.find(n => n.id === "a.ts");
    assert.ok(a, "expected a.ts to appear in the diff instead of an empty/wrong one");
    assert.equal(a?.status, "modified");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(prDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
