// aggregate.mts - pure graph-collapsing logic: given the full node/edge set and which
// file nodes are currently expanded, compute the visible nodes and the aggregated edges
// to render. No DOM/d3 dependency, so it runs identically in Node (tests, this file's
// own dist/aggregate.mjs) and in the browser (graph-client.ts imports the same file).

import type { GraphNode, GraphEdge } from "./types.mjs";

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
    g.statuses.add(status ?? "unchanged");
  }

  // Resolve any edge endpoint (file or symbol id) against the current expand state:
  // keep it as-is if it's a currently-visible symbol under an expanded file, else
  // collapse to its containing file. A no-op for endpoints that are already file ids
  // (import/sibling edges, and a reference edge's source) — a file always resolves
  // to itself — so this applies uniformly with no need to branch on edge type.
  function resolve(id: string): string {
    const file = fileOf(nodeMeta, id);
    return (expandedNodes.has(file) && visible.has(id)) ? id : file;
  }

  for (const e of edges) {
    const src = resolve(e.src), tar = resolve(e.tar);
    if (src === tar) continue;
    if (!visible.has(src) || !visible.has(tar)) continue;
    add(src, tar, e.type, e.status);
  }

  const result: GraphEdge[] = [];
  for (const g of groups.values()) {
    result.push({ src: g.src, tar: g.tar, type: primaryType(g.types), status: aggregateStatus(g.statuses), count: g.count });
  }
  return result;
}
