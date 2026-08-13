# dep-graph-core

A TypeScript library that builds a **file/symbol dependency graph** for a git pull request — which files changed, how they reference each other, and which symbols were added, modified, or removed — plus an optional local D3 force-graph viewer to look at the result in a browser.

All parsing is deterministic (git + tree-sitter AST). No AI involved.

## Features

- **File-level graph** — every changed file as a node, import/reference edges between them
- **Symbol-level detail** — changed symbols per file (function/class/type/etc.), with call edges between specific symbols (including `new X()`), plus file-level reference edges for named imports that couldn't be attributed to a specific caller
- **Change status** — added / modified / removed / unchanged, per file and per symbol
- **Angular signal support** — `computed()`, `signal()`, `input()` class properties correctly traced
- **Sibling links** — `.ts`/`.html`/`.scss` component triplets grouped together
- **Go support** — package import suffix matching
- **Optional D3 viewer** — a local HTTP server + browser UI with no external network access required

## Installation

Not published to a registry. Install directly from this repo as a git dependency:

```bash
npm install github:JeVaughan/copilot-dep-graph
# or pin to a tag/commit:
npm install github:JeVaughan/copilot-dep-graph#v0.1.0
```

npm runs this package's `prepare` script on install, which builds the TypeScript source — there's nothing to build yourself.

## Usage

```ts
import { parsePr, startViewer } from "dep-graph-core";

const { nodes, edges } = parsePr({
  repoPath: "/path/to/repo",  // absolute path to a local git checkout
  prRef: "FETCH_HEAD",        // any git ref / commit SHA
  baseRef: "main",            // optional: override the base branch (default "HEAD")
  exclude: ["migrations"],    // optional: path substrings to exclude
});

// Look at it in a browser:
const viewer = await startViewer({ title: "My PR", nodes, edges });
console.log(viewer.url); // http://127.0.0.1:PORT/

// Push an updated graph to any open browser tab:
viewer.setGraph({ title: "My PR (updated)", nodes: newNodes, edges: newEdges });

// Shut the server down:
await viewer.close();
```

`parsePr` has no dependency on `startViewer` — use it standalone if you just want the graph data (e.g. to render with your own UI, or serialize to JSON).

### Resolving a GitHub PR number (`resolveGitHubPr`)

`parsePr` takes a `prRef` — any git ref or SHA already present in the local checkout — and deliberately never fetches anything itself, so it stays usable against any git repo, not just GitHub's. If all you have is a PR *number* against a GitHub remote, use `resolveGitHubPr` to turn that into a `prRef`:

```ts
import { parsePr, resolveGitHubPr } from "dep-graph-core";

const prRef = resolveGitHubPr(repoPath, 123); // fetches refs/pull/123/head, returns "FETCH_HEAD"
const { nodes, edges } = parsePr({ repoPath, prRef });
```

This matters for PRs that were squash- or rebase-merged: after a merge like that, the PR's original commits are no longer reachable from `main` at all, so a local checkout's `HEAD` has no ancestry relationship with them. `resolveGitHubPr` fetches the PR's head commit directly via GitHub's `refs/pull/<n>/head` convention (which stays valid even after the PR is merged, until the ref is eventually garbage-collected), so `parsePr`'s merge-base logic has something real to diff against.

### Graph data shape

Nodes and edges are a deliberately minimal, generic graph shape — no visualization-specific fields, so the parser and any viewer stay decoupled. The canonical definitions live in [src/types.mts](src/types.mts), which has zero imports of its own (no Node built-ins, no treesitter) specifically so it's safe to pull into the browser build without dragging anything else along — `parse.mts`, `aggregate.mts`, and `graph-client.ts` all import from there rather than each declaring their own copy:

```ts
interface GraphNode {
  id: string;         // e.g. "src/foo.ts" (file) or "src/foo.ts:::bar" (symbol)
  label: string;      // display name, e.g. "foo.ts" or "bar" — id without the file-prefix/"::: " plumbing
  type: string;       // "file" for file nodes, or a symbol kind: function/method/class/interface/type/enum/property/const
  parent?: string;    // for symbol nodes, the id of their containing file
  status?: string;    // "added" | "modified" | "removed" | "unchanged"
}

interface GraphEdge {
  src: string;         // source node id
  tar: string;         // target node id
  type: string;        // "import" | "call" | "reference" | "sibling"
  status?: string | null;
  count: number;        // always 1 from parsePr; > 1 only after aggregate.mts collapses several edges into one
}
```

A symbol is just a node like any other, flattened alongside its file rather than nested inside it — `parent` is what ties it back to its containing file. There's still no separate field for a file's full repo path or a symbol's source-line signature; those are dropped for now rather than carried as opaque payload.

### Collapsing edges (`src/aggregate.mts`)

The viewer collapses a file's symbols into the file node itself when it isn't expanded. `aggregate.mts` (pure, dependency-free, tested independently of the DOM) decides which nodes are visible for a given expand state and re-resolves every edge against that — several raw edges landing on the same visible `(src, tar)` pair, regardless of their original `type`, merge into a single `GraphEdge` with `count` set to the total and `type`/`status` each collapsed to one representative value. It's imported directly by `graph-client.ts` (served as `/aggregate.mjs` alongside `/graph-client.js`, both loaded as real ES modules) so the browser and the test suite run the exact same logic — no separate, hand-verified copy.

Each file has an expand *level*, not just an on/off state: 0 (collapsed) → 1 (changed symbols only) → 2 (every symbol, including unchanged) → back to 0. `aggregate.mts`'s `nextExpandLevel` skips any level that wouldn't add anything new — an all-added file has no unchanged symbols, so level 1 goes straight back to 0; a file with no changed symbols (the diff didn't touch anything tree-sitter treats as a symbol) skips straight from 0 to 2.

### Embedding in a host tool

If you're wiring this into something like a GitHub Copilot CLI canvas extension, keep that wiring in a separate, shallow package: import `parsePr`/`startViewer` from this library and adapt their plain return values to whatever the host expects. This library has no knowledge of any specific host.

## Interactions (viewer)

| Action | Result |
|--------|--------|
| Double-click file node | Cycles changed symbols only → all symbols (incl. unchanged) → collapsed, skipping any step that wouldn't show anything new. The file node's own size never changes; a small badge on it shows `+N` while there's more to reveal, or `-` once double-clicking would only collapse it |
| Hover a reference | Shows its type, endpoints, and status — collapsing a file aggregates every underlying reference between two visible nodes into one line, regardless of the original type (a `call` and a `reference` edge landing on the same pair merge into one). Status is the merged result (`unchanged` mixed with a real status just becomes that status; two or more *different* real statuses become `modified`), type similarly picks one representative (`call` > `reference` > `import` > `sibling`), and the tooltip shows the total count merged in |
| Drag node | Re-position (layout re-stabilises) |
| Scroll | Zoom in/out |
| Click background + drag | Pan |

## Node shapes

| Shape | Meaning |
|-------|---------|
| ● Circle | File node / property / const |
| ▲ Triangle | Function / method |
| ■ Square | Class / interface / type / enum |

## Edge colours

Edge type (import / call / reference / sibling) is not shown as a distinct line style — hover an edge to see it. Colour is status only:

| Colour | Meaning |
|--------|---------|
| Green | Added |
| Yellow | Modified |
| Red | Removed |
| Grey | Unchanged |

## Supported languages

| Language | Symbols | Call edges | Import edges |
|----------|---------|------------|--------------|
| TypeScript / TSX | ✓ | ✓ | ✓ |
| JavaScript / JSX | ✓ | ✓ | ✓ |
| Go | ✓ | ✓ | ✓ |
| Other | — | — | regex fallback |

## TypeScript path aliases

`parsePr` resolves `@alias/*`-style imports via a hardcoded alias map in [src/parse.mts](src/parse.mts) (`TS_ALIASES`), tailored to one specific frontend monorepo layout. It is not read from the target repo's `tsconfig.json` — if you're pointing this at a different repo, edit that map (or open an issue/PR to make it configurable).

## Project structure

```
dep-graph-core/
├── src/
│   ├── index.mts          # Public API barrel
│   ├── types.mts          # Shared GraphNode/GraphEdge/GraphData shape — zero imports of its own
│   ├── parse.mts          # parsePr: git diff + tree-sitter → graph data
│   ├── parse.test.mts     # node:test suite for parse.mts, runs against the built dist/
│   ├── github.mts         # resolveGitHubPr: GitHub PR number → prRef (fetch, refs/pull/<n>/head)
│   ├── github.test.mts
│   ├── treesitter.mts     # AST extraction (TypeScript + Go)
│   ├── treesitter.test.mts
│   ├── viewer.mts         # Local HTTP/SSE server serving the D3 UI
│   ├── viewer.test.mts
│   ├── aggregate.mts      # Pure edge-collapsing logic, shared by graph-client.ts and its tests
│   ├── aggregate.test.mts
│   └── graph-client.ts    # Browser-side D3 force graph renderer (real ES module)
├── samples/               # Checked-in base/pr fixtures for the dev harness (see below)
├── dev/serve.mts         # Manual dev harness (not published)
├── graph.html            # D3 force graph UI shell (loads /graph-client.js as a module)
├── d3.min.js             # Bundled D3 v7 (no CDN)
├── package.json
├── tsconfig.json          # Compiles src/*.mts → dist/ (Node ESM library)
└── tsconfig.browser.json  # Compiles src/graph-client.ts (+ aggregate.mts) → dist/ (browser ESM)
```

`dist/` and `node_modules/` are gitignored — they're produced by `npm run build` (or automatically via `prepare` when installed as a dependency).

### Developing

```bash
npm install
npm run build   # or: npm run watch
npm test         # runs the node:test suite against the built dist/
```

### Trying it out in a browser

`npm run dev` starts the D3 viewer with sample data and prints a URL to open. Pass `--repo` to parse a real PR diff instead, or `--sample <name>` to run against a checked-in fixture under [samples/](samples/) (e.g. `typescript-small`, which exercises added/modified/removed files and nested class methods, or `typescript-medium`, which adds removed edges and mixed changed/unchanged children). It binds a stable port (4500) by default, so a port-forward set up once (e.g. in a remote/devcontainer session) keeps working across restarts — pass `--port` to use a different one:

```bash
npm run dev
npm run dev -- --repo /path/to/repo --pr HEAD --base main
npm run dev -- --sample typescript-small
npm run dev -- --port 4501
```

A sample is a plain `base/`/`pr/` pair of file snapshots (no nested `.git` — embedding a real git repo inside this one is a recognized anti-pattern). `dev/serve.mts` materializes it into a scratch git repo with two real commits on the fly and diffs it exactly like any other `--repo`.

## License

MIT
