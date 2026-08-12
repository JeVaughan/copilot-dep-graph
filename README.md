# dep-graph — Copilot PR Dependency Graph

A [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) canvas extension that renders a **D3 force-directed dependency graph** for any pull request — showing which files changed, how they reference each other, and which symbols were added, modified, or removed.

All parsing is deterministic (git + tree-sitter AST). No AI involved in the graph data.

![dep-graph screenshot](https://user-images.githubusercontent.com/placeholder/dep-graph.png)

## Features

- **File-level graph** — every changed file as a node, import/reference edges between them
- **Symbol expansion** — double-click any TypeScript/Go file to expand its changed symbols
- **Change status colouring** — green (added), yellow (modified), red (removed)
- **Angular signal support** — `computed()`, `signal()`, `input()` class properties correctly traced
- **Intra-file edges** — symbol→symbol references within a file shown on expansion
- **Sibling links** — `.ts`/`.html`/`.scss` component triplets grouped together
- **Alias resolution** — reads `tsconfig.json` paths at parse time (no hardcoded config)
- **Go support** — package import suffix matching
- **D3 served locally** — no internet access required in the iframe

## Installation

### From this repo (recommended)

```bash
# User-scoped: works across all your projects, nothing committed to project repos
copilot extension install https://github.com/JeVaughan/copilot-dep-graph/tree/main/dep-graph --scope user

# Project-scoped: committed to .github/extensions/ of the current repo
copilot extension install https://github.com/JeVaughan/copilot-dep-graph/tree/main/dep-graph --scope project
```

Or from within the Copilot CLI chat:

```
install_extension("https://github.com/JeVaughan/copilot-dep-graph/tree/main/dep-graph")
```

### Requirements

- Node.js runtime provided by the Copilot CLI host
- Prebuilt tree-sitter native binaries are included for **win32-x64**
- Other platforms need to rebuild: `cd dep-graph && npm install`

## Usage

Open the canvas from the Copilot CLI chat:

```
Open a dependency graph for PR FETCH_HEAD in C:\path\to\repo
```

Or invoke directly:

```js
open_canvas({
  canvasId: "dep-graph",
  instanceId: "my-graph",
  input: {
    prRef: "FETCH_HEAD",        // or any git ref / commit SHA
    repoPath: "/path/to/repo",  // absolute path to the local git checkout
    baseRef: "main",            // optional: override the base branch
    exclude: ["migrations"]     // optional: path fragments to exclude
  }
})
```

## Interactions

| Action | Result |
|--------|--------|
| Double-click file node | Expand/collapse changed symbols |
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

| Colour | Meaning |
|--------|---------|
| Green | Added |
| Yellow | Modified |
| Red | Removed |
| Grey | Unchanged |
| Faint dotted | Sibling (structural, same component) |

## Supported languages

| Language | Symbols | Call edges | Import edges |
|----------|---------|------------|--------------|
| TypeScript / TSX | ✓ | ✓ | ✓ |
| JavaScript / JSX | ✓ | ✓ | ✓ |
| Go | ✓ | ✓ | ✓ |
| Other | — | — | regex fallback |

## tsconfig path aliases

The extension reads `tsconfig.json` at the repo root (or `frontend/tsconfig.json`) at parse time to resolve TypeScript path aliases like `@app/*`, `@app-shared/*`, etc. No hardcoded configuration needed.

## Project structure

```
dep-graph/
├── extension.mjs     # Canvas wiring, HTTP server, PR parsing pipeline
├── treesitter.mjs    # AST extraction (TypeScript + Go)
├── graph.html        # D3 force graph UI (self-contained)
├── package.json      # tree-sitter dependencies
├── d3.min.js         # Bundled D3 v7 (no CDN)
└── node_modules/     # Prebuilt tree-sitter native binaries (win32-x64)
```

## License

MIT
