// aggregate.mts - pure graph-collapsing logic: given the full node/edge set and which
// file nodes are currently expanded, compute the visible nodes and the aggregated edges
// to render. No DOM/d3 dependency, so it runs identically in Node (tests, this file's
// own dist/aggregate.mjs) and in the browser (graph-client.ts imports the same file).

import type { GraphNode, GraphEdge } from "./types.mjs";

// A container's expand level: 0 = collapsed, 1 = own-status-changed children only,
// 2 = also children that are themselves unchanged but touch a changed edge, 3 =
// everything (also fully unchanged children with no changed edge either). Absent
// from the map is equivalent to 0.
export type ExpandLevels = Map<string, number>;

const TYPE_PRIORITY = ["call", "reference", "import", "sibling"];

function primaryType(types: Set<string>): string {
  for (const t of TYPE_PRIORITY) if (types.has(t)) return t;
  return [...types][0];
}

// "unchanged" never dilutes a real status (it carries no signal of its own). Two or more
// *different* real statuses (e.g. some added, some removed) collapse to "modified" — the
// only one of the four that doesn't make a false claim about the direction of change.
export function aggregateStatus(statuses: Set<string>): string | null {
  const real = [...statuses].filter(s => s !== "unchanged");
  if (real.length === 0) return null;
  if (real.length === 1) return real[0];
  return "modified";
}

// Which node ids touch at least one changed (non-"unchanged") edge — the minimal
// signal visibleChildren's middle tier needs. Deliberately just a Set<id> (not each
// node's actual aggregate status — nothing here needs that) and computed from the
// full edge set, not whatever's currently rendered, so it can't circularly depend on
// the current expand state.
function nodesWithChangedEdge(edges: GraphEdge[]): Set<string> {
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.status && e.status !== "unchanged") { ids.add(e.src); ids.add(e.tar); }
  }
  return ids;
}

// Which of a container's direct children are visible at a given expand level: none at
// 0; own-status changed (added/modified/removed) at 1; also unchanged-status children
// that touch a changed edge at 2; everything (also fully unchanged ones) at 3+.
export function visibleChildren(children: GraphNode[], level: number, hasChangedEdge: (id: string) => boolean): GraphNode[] {
  if (level <= 0) return [];
  if (level >= 3) return children;
  return children.filter(c => {
    const ownChanged = c.status && c.status !== "unchanged";
    return level === 1 ? ownChanged : ownChanged || hasChangedEdge(c.id);
  });
}

// Cycles a container's expand level: 0 (collapsed) -> 1 (own-status changed) ->
// 2 (+ unchanged children touching a changed edge) -> 3 (+ everything else) -> 0,
// skipping any level that wouldn't actually add anything new to what's already shown.
// E.g. a container with no own-changed children but some edge-touching ones skips
// level 1, going straight from 0 to 2; one with nothing but fully unchanged, unrelated
// children skips straight to 3 — that bottom tier only ever shows once nothing else
// is left to reveal.
export function nextExpandLevel(current: number, ownChangedCount: number, edgeChangedCount: number, fullyUnchangedCount: number): number {
  const countAtLevel = [ownChangedCount, edgeChangedCount, fullyUnchangedCount];
  for (let level = current + 1; level <= 3; level++) {
    if (countAtLevel[level - 1] > 0) return level;
  }
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

// Which node ids are actually visible: every root node (no parent — a file, today),
// plus — recursively — each visible container's visibleChildren() at its own expand
// level. A node several levels deep (e.g. a method on a class) is visible only when
// every ancestor between it and the root is itself visible AND expanded enough to
// reveal it; a container that's hidden or collapsed hides its whole subtree.
export function computeVisibleNodeIds(nodes: GraphNode[], edges: GraphEdge[], expandLevels: ExpandLevels): Set<string> {
  const childrenByParent = groupByParent(nodes);
  const changedEdgeIds = nodesWithChangedEdge(edges);
  const hasChangedEdge = (id: string) => changedEdgeIds.has(id);
  const visible = new Set<string>();
  const queue: GraphNode[] = nodes.filter(n => !n.parent);
  for (const n of queue) visible.add(n.id);
  while (queue.length) {
    const parent = queue.shift()!;
    const level = expandLevels.get(parent.id) ?? 0;
    for (const c of visibleChildren(childrenByParent.get(parent.id) ?? [], level, hasChangedEdge)) {
      visible.add(c.id);
      queue.push(c);
    }
  }
  return visible;
}

// Resolve an edge endpoint to whatever's actually shown for it: itself if visible,
// else the nearest visible ancestor (walking up .parent one hop at a time) — a
// collapsed grandchild's edge lands on its nearest expanded container, not straight
// on the root. Always terminates: computeVisibleNodeIds marks every root visible, so
// the walk never runs past one. Falls back to a bare file-id prefix for an id with no
// nodeMeta entry at all (defensive — real parsePr output always has one).
function resolveToVisible(nodeMeta: Map<string, GraphNode>, visible: Set<string>, id: string): string {
  let cur = id;
  while (!visible.has(cur)) {
    const n = nodeMeta.get(cur);
    if (n?.parent) { cur = n.parent; continue; }
    const i = cur.indexOf(":::");
    return i === -1 ? cur : cur.slice(0, i);
  }
  return cur;
}

interface Group { src: string; tar: string; count: number; types: Set<string>; statuses: Set<string>; }

// Builds the aggregated, render-ready edge list. Aggregation is keyed purely on the
// resolved (src, tar) pair — NOT on edge type — so a call edge and a reference
// edge that both collapse onto the same pair of visible nodes merge into one line
// instead of rendering as two separate, differently-coloured edges.
export function buildLinks(nodes: GraphNode[], edges: GraphEdge[], expandLevels: ExpandLevels): GraphEdge[] {
  const nodeMeta = new Map(nodes.map(n => [n.id, n]));
  const visible = computeVisibleNodeIds(nodes, edges, expandLevels);
  const groups = new Map<string, Group>();

  function add(src: string, tar: string, type: string, status: string | null | undefined) {
    const key = src + "->" + tar;
    let g = groups.get(key);
    if (!g) { g = { src, tar, count: 0, types: new Set(), statuses: new Set() }; groups.set(key, g); }
    g.count++;
    g.types.add(type);
    g.statuses.add(status ?? "unchanged");
  }

  for (const e of edges) {
    const src = resolveToVisible(nodeMeta, visible, e.src);
    const tar = resolveToVisible(nodeMeta, visible, e.tar);
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
