// graph-diff.mts - diffs two independently-built edge lists (one per version) purely
// by structural presence: an edge is added/removed/unchanged depending on which
// version(s) it shows up in. Never "modified" — unlike a node, an edge has no
// content of its own to compare, so its status can't mean anything but presence.
import type { GraphEdge } from "../types.mjs";

function edgeKey(e: GraphEdge): string {
  return `${e.src}->${e.tar}:${e.type}`;
}

export function diffEdges(base: GraphEdge[], pr: GraphEdge[]): GraphEdge[] {
  const baseKeys = new Set(base.map(edgeKey));
  const prKeys = new Set(pr.map(edgeKey));
  const byKey = new Map<string, GraphEdge>();
  for (const e of base) if (!byKey.has(edgeKey(e))) byKey.set(edgeKey(e), e);
  for (const e of pr) byKey.set(edgeKey(e), e); // prefer the pr copy when both exist

  const edges: GraphEdge[] = [];
  for (const [key, e] of byKey) {
    const status = !baseKeys.has(key) ? "added" : !prKeys.has(key) ? "removed" : "unchanged";
    edges.push({ src: e.src, tar: e.tar, type: e.type, status, count: e.count });
  }
  return edges;
}
