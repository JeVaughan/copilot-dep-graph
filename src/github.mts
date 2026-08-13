// github.mts - GitHub-specific convenience helper, kept separate from parse.mts so the
// core parsePr() stays fetch-free and host-agnostic. This is the only place that knows
// about GitHub's `refs/pull/<n>/head` convention.

import { spawnSync } from "node:child_process";

// Fetches a GitHub PR's head commit into the local repo and returns a ref usable
// directly as parsePr()'s `prRef`. This makes squash/rebase-merged PRs resolve
// correctly (parsePr's merge-base logic needs the PR's actual head commit, not
// whatever main was rewritten to), without parsePr itself needing to know about
// GitHub or fetching.
//
// Usage:
//   const prRef = resolveGitHubPr(repoPath, 123);
//   const { nodes, edges } = parsePr({ repoPath, prRef });
export function resolveGitHubPr(repoPath: string, prNumber: number, remote = "origin"): string {
    const r = spawnSync("git", ["--no-pager", "fetch", remote, `refs/pull/${prNumber}/head`], {
        cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git fetch refs/pull/${prNumber}/head failed`);
    return "FETCH_HEAD";
}
