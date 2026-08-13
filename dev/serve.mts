// dev/serve.mts - manual test harness (not part of the published package).
// Starts the D3 viewer against a real PR diff, a checked-in sample fixture,
// or built-in sample data, and prints a URL to open in a browser.
//
// Usage:
//   npm run dev
//   npm run dev -- --repo /path/to/repo [--pr HEAD] [--base HEAD~1] [--exclude foo,bar] [--port 4500]
//   npm run dev -- --sample class-methods
//
// Binds a stable port (4500) by default so the URL/port-forward doesn't
// change across restarts. Pass --port to use a different one.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePr, startViewer, type GraphData } from "../dist/index.mjs";

const DEFAULT_PORT = 4500;
const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// A "sample" is a checked-in fixture with plain base/ and pr/ file snapshots
// (no nested .git — that's a git anti-pattern for a fixture living inside this
// repo). This materializes it into a scratch git repo with two real commits,
// exactly what a hand-built repro would look like, so parsePr's actual git
// diffing runs against it unmodified.
function materializeSample(name: string): string {
  const src = join(SAMPLES_DIR, name);
  const repo = mkdtempSync(join(tmpdir(), `dep-graph-sample-${name}-`));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed for sample "${name}"`);
  };
  git("init", "-q");
  git("config", "user.email", "sample@example.com");
  git("config", "user.name", "Sample");
  cpSync(join(src, "base"), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("rm", "-rq", "--ignore-unmatch", ".");
  cpSync(join(src, "pr"), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", "pr");
  const cleanup = () => rmSync(repo, { recursive: true, force: true });
  process.on("exit", cleanup);
  // Node's default SIGINT/SIGTERM handling skips the "exit" event unless something
  // is listening, so register explicitly — otherwise every Ctrl+C leaks this scratch dir.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { cleanup(); process.exit(); });
  return repo;
}

const sampleArg = arg("sample");
const repoPath = sampleArg ? materializeSample(sampleArg) : arg("repo");
const prRef = arg("pr") ?? "HEAD";
const baseRef = arg("base") ?? "HEAD~1";
const excludeArg = arg("exclude");
const port = Number(arg("port") ?? DEFAULT_PORT);

let graph: GraphData;

if (repoPath) {
  console.log(`Parsing ${repoPath} (${baseRef}...${prRef})...`);
  const { nodes, edges } = parsePr({
    repoPath,
    prRef,
    baseRef,
    exclude: excludeArg ? excludeArg.split(",") : [],
  });
  graph = { title: `${repoPath} (${prRef} vs ${baseRef})`, nodes, edges };
  console.log(`Parsed ${nodes.length} node(s), ${edges.length} edge(s).`);
} else {
  console.log("No --repo given, using sample data. Pass --repo <path> to parse a real diff instead.");
  graph = {
    title: "Sample Graph",
    nodes: [
      { id: "a.ts", label: "a.ts", type: "file", status: "added" },
      { id: "a.ts:::helper", label: "helper", type: "function", parent: "a.ts", status: "added" },
      { id: "b.ts", label: "b.ts", type: "file", status: "modified" },
      { id: "b.ts:::doStuff", label: "doStuff", type: "function", parent: "b.ts", status: "added" },
      { id: "c.ts", label: "c.ts", type: "file", status: "removed" },
    ],
    edges: [
      { src: "a.ts", tar: "b.ts", status: "added", type: "import", count: 1 },
      { src: "b.ts", tar: "c.ts", status: "removed", type: "import", count: 1 },
      { src: "b.ts:::doStuff", tar: "a.ts:::helper", status: null, type: "call", count: 1 },
    ],
  };
}

let viewer;
try {
  viewer = await startViewer(graph, { port });
} catch (err: any) {
  if (err?.code === "EADDRINUSE") {
    console.error(`\nPort ${port} is already in use — is another dev server already running? Pass --port to use a different one.\n`);
    process.exit(1);
  }
  throw err;
}
console.log(`\nOpen in a browser: ${viewer.url}\n`);
console.log("Press Ctrl+C to stop.");
