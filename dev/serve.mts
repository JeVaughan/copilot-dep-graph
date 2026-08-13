// dev/serve.mts - manual test harness (not part of the published package).
// Starts the D3 viewer against either a real PR diff or built-in sample
// data, and prints a URL to open in a browser.
//
// Usage:
//   npm run dev
//   npm run dev -- --repo /path/to/repo [--pr HEAD] [--base HEAD~1] [--exclude foo,bar] [--port 4500]
//
// Binds a stable port (4500) by default so the URL/port-forward doesn't
// change across restarts. Pass --port to use a different one.

import { parsePr, startViewer, type GraphData } from "../dist/index.mjs";

const DEFAULT_PORT = 4500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const repoPath = arg("repo");
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
      { id: "a.ts", type: "file", status: "added" },
      { id: "a.ts:::helper", type: "function", parent: "a.ts", status: "added" },
      { id: "b.ts", type: "file", status: "modified" },
      { id: "b.ts:::doStuff", type: "function", parent: "b.ts", status: "added" },
      { id: "c.ts", type: "file", status: "removed" },
    ],
    edges: [
      { src: "a.ts", tar: "b.ts", status: "added", type: "import" },
      { src: "b.ts", tar: "c.ts", status: "removed", type: "import" },
      { src: "b.ts:::doStuff", tar: "a.ts:::helper", status: null, type: "call" },
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
