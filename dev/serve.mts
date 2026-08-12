// dev/serve.mts - manual test harness (not part of the published package).
// Starts the D3 viewer against either a real PR diff or built-in sample
// data, and prints a URL to open in a browser.
//
// Usage:
//   npm run dev
//   npm run dev -- --repo /path/to/repo [--pr HEAD] [--base HEAD~1] [--exclude foo,bar]

import { parsePr, startViewer, type GraphData } from "../dist/index.mjs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const repoPath = arg("repo");
const prRef = arg("pr") ?? "HEAD";
const baseRef = arg("base") ?? "HEAD~1";
const excludeArg = arg("exclude");

let graph: GraphData;

if (repoPath) {
  console.log(`Parsing ${repoPath} (${baseRef}...${prRef})...`);
  const { nodes, links } = parsePr({
    repoPath,
    prRef,
    baseRef,
    exclude: excludeArg ? excludeArg.split(",") : [],
  });
  graph = { title: `${repoPath} (${prRef} vs ${baseRef})`, nodes, links };
  console.log(`Parsed ${nodes.length} node(s), ${links.length} link(s).`);
} else {
  console.log("No --repo given, using sample data. Pass --repo <path> to parse a real diff instead.");
  graph = {
    title: "Sample Graph",
    nodes: [
      { id: "a.ts", label: "a.ts", path: "a.ts", status: "added" },
      { id: "b.ts", label: "b.ts", path: "b.ts", status: "modified" },
      { id: "c.ts", label: "c.ts", path: "c.ts", status: "removed" },
    ],
    links: [
      { source: "a.ts", target: "b.ts", status: "added", _linkType: "import" },
      { source: "b.ts", target: "c.ts", status: "removed", _linkType: "import" },
    ],
  };
}

const viewer = await startViewer(graph);
console.log(`\nOpen in a browser: ${viewer.url}\n`);
console.log("Press Ctrl+C to stop.");
