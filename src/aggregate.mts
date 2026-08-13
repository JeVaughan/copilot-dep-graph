// aggregate.mts - pure graph-collapsing logic: given the full node/edge set and which
// file nodes are currently expanded, compute the visible nodes and the aggregated edges
// to render. No DOM/d3 dependency, so it runs identically in Node (tests, this file's
// own dist/aggregate.mjs) and in the browser (graph-client.ts imports the same file).

import type { GraphNode, GraphEdge } from "./types.mjs";

// A file's expand level: 0 = collapsed, 1 = changed symbols only, 2 = all symbols
// (changed + unchanged). Absent from the map is equivalent to 0.
export type ExpandLevels = Map<string, number>;

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

// Which of a file's symbol children are visible at a given expand level: none at 0,
// only changed (non-"unchanged") ones at 1, everything at 2+.
export function visibleChildren(children: GraphNode[], level: number): GraphNode[] {
  if (level <= 0) return [];
  if (level >= 2) return children;
  return children.filter(c => c.status && c.status !== "unchanged");
}

// Cycles a file's expand level: 0 (collapsed) -> 1 (changed only) -> 2 (all) -> 0,
// skipping any level that wouldn't actually add anything new to what's already shown.
// E.g. an all-added file has no unchanged symbols, so 1 goes straight back to 0; a file
// with no changed symbols (only unchanged) skips 1 entirely, going straight from 0 to 2.
export function nextExpandLevel(current: number, changedCount: number, unchangedCount: number): number {
  if (changedCount === 0 && unchangedCount === 0) return current;
  if (current === 0) return changedCount > 0 ? 1 : 2;
  if (current === 1) return unchangedCount > 0 ? 2 : 0;
  return 0;
}

function groupByParent(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const byParent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.parent) continue;
    if (!byParent.has(n.parent)) byParent.set(n.parent, []);
    byParent.get(n.parent)!.push(n);
  }
  return byParent;
}

// Which node ids are actually visible: every file node, plus each expanded file's
// visibleChildren() at its own level.
export function computeVisibleNodeIds(nodes: GraphNode[], expandLevels: ExpandLevels): Set<string> {
  const childrenByParent = groupByParent(nodes);
  const visible = new Set<string>();
  for (const n of nodes) if (!n.parent) visible.add(n.id);
  for (const [parentId, children] of childrenByParent) {
    const level = expandLevels.get(parentId) ?? 0;
    for (const c of visibleChildren(children, level)) visible.add(c.id);
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
export function buildLinks(nodes: GraphNode[], edges: GraphEdge[], expandLevels: ExpandLevels): GraphEdge[] {
  const nodeMeta = new Map(nodes.map(n => [n.id, n]));
  const visible = computeVisibleNodeIds(nodes, expandLevels);
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
    return ((expandLevels.get(file) ?? 0) > 0 && visible.has(id)) ? id : file;
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
