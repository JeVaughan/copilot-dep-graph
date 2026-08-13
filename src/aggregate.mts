// aggregate.mts - pure graph-collapsing logic: given the full node/edge set and which
// file nodes are currently expanded, compute the visible nodes and the aggregated edges
// to render. No DOM/d3 dependency, so it runs identically in Node (tests, this file's
// own dist/aggregate.mjs) and in the browser (graph-client.ts imports the same file).
//
// GraphNode/GraphEdge are declared locally (structurally identical to parse.mts's)
// rather than imported, so this file has zero dependency on parse.mts/treesitter.mts —
// pulling those in would drag treesitter.mts's `import.meta.url` into the browser
// compile, which tsconfig.browser.json's settings can't handle.
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  parent?: string;
  status?: string;
}

export interface GraphEdge {
  src: string;
  tar: string;
  type: string;
  status?: string | null;
  count: number;
}

const TYPE_PRIORITY = ["call", "reference", "import", "sibling"];

function primaryType(types: Set<string>): string {
  for (const t of TYPE_PRIORITY) if (types.has(t)) return t;
  return [...types][0];
}

// "unchanged" never dilutes a real status (it carries no signal of its own). Two or more
// *different* real statuses (e.g. some added, some removed) collapse to "modified" — the
// only one of the four that doesn't make a false claim about the direction of change.
function aggregateStatus(statuses: Set<string>): string | null {
  const real = [...statuses].filter(s => s !== "unchanged");
  if (real.length === 0) return null;
  if (real.length === 1) return real[0];
  return "modified";
}

// Which symbol nodes are actually visible: every file node, plus the changed (non-
// "unchanged") symbol children of any expanded file.
export function computeVisibleNodeIds(nodes: GraphNode[], expandedNodes: Set<string>): Set<string> {
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    if (!childrenByParent.has(n.parent)) childrenByParent.set(n.parent, []);
    childrenByParent.get(n.parent)!.push(n);
  }
  const visible = new Set<string>();
  for (const n of nodes) if (!n.parent) visible.add(n.id);
  for (const [parentId, children] of childrenByParent) {
    if (!expandedNodes.has(parentId)) continue;
    for (const c of children) if (c.status && c.status !== "unchanged") visible.add(c.id);
  }
  return visible;
}

// Resolve any node id (file or symbol) to its containing file's id.
function fileOf(nodeMeta: Map<string, GraphNode>, id: string): string {
  const n = nodeMeta.get(id);
  if (n) return n.parent ?? id;
  const i = id.indexOf(":::");
  return i === -1 ? id : id.slice(0, i);
}

interface Group { src: string; tar: string; count: number; types: Set<string>; statuses: Set<string>; }

// Builds the aggregated, render-ready edge list. Aggregation is keyed purely on the
// resolved (src, tar) pair — NOT on edge type — so a call edge and a reference
// edge that both collapse onto the same pair of visible nodes merge into one line
// instead of rendering as two separate, differently-coloured edges.
export function buildLinks(nodes: GraphNode[], edges: GraphEdge[], expandedNodes: Set<string>): GraphEdge[] {
  const nodeMeta = new Map(nodes.map(n => [n.id, n]));
  const visible = computeVisibleNodeIds(nodes, expandedNodes);
  const groups = new Map<string, Group>();

  function add(src: string, tar: string, type: string, status: string | null | undefined) {
    const key = src + "->" + tar;
    let g = groups.get(key);
    if (!g) { g = { src, tar, count: 0, types: new Set(), statuses: new Set() }; groups.set(key, g); }
    g.count++;
    g.types.add(type);
    g.statuses.add(status && status !== "unchanged" ? status : "unchanged");
  }

  for (const e of edges) {
    if (e.type === "import" || e.type === "sibling") {
      if (visible.has(e.src) && visible.has(e.tar)) add(e.src, e.tar, e.type, e.status);
      continue;
    }

    if (e.type === "call") {
      const srcFile = fileOf(nodeMeta, e.src), tarFile = fileOf(nodeMeta, e.tar);
      // Resolve each side independently: prefer the symbol node if its file is
      // expanded and that symbol is actually visible, else collapse to the file.
      const srcSym = expandedNodes.has(srcFile) && visible.has(e.src) ? e.src : null;
      const tarSym = expandedNodes.has(tarFile) && visible.has(e.tar) ? e.tar : null;
      const src = srcSym ?? srcFile;
      const tar = tarSym ?? tarFile;
      if (src === tar) continue;
      if (!visible.has(src) || !visible.has(tar)) continue;
      // Use the calling symbol's own status as-is — no falling back to the file's
      // status. aggregateStatus() already ensures a real status among several
      // merged edges isn't hidden by a genuinely-unchanged one.
      add(src, tar, "call", e.status);
      continue;
    }

    if (e.type === "reference") {
      // Source is always a file already; only the target might be a symbol.
      const tarFile = fileOf(nodeMeta, e.tar);
      const tarSym = expandedNodes.has(tarFile) && visible.has(e.tar) ? e.tar : null;
      const tar = tarSym ?? tarFile;
      if (e.src === tar) continue;
      if (!visible.has(e.src) || !visible.has(tar)) continue;
      add(e.src, tar, "reference", e.status);
    }
  }

  const result: GraphEdge[] = [];
  for (const g of groups.values()) {
    result.push({ src: g.src, tar: g.tar, type: primaryType(g.types), status: aggregateStatus(g.statuses), count: g.count });
  }
  return result;
}
