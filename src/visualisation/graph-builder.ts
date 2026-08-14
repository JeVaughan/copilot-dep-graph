import { buildLinks, visibleChildren, aggregateStatus } from "../aggregate.mjs";
import type { GraphNode } from "../types.mjs";
import { type VizState, hasChangedEdge } from "./state.js";
import { STATUS_COLOR } from "./colors.js";
import { depthScale } from "./sizing.js";

export interface RenderGraph {
  allNodes: any[];
  allLinks: any[];
  nodeById: Map<string, any>;
  containerDepth: Map<string, number>;
  isFirstRender: boolean;
  degreeMap: Map<string, number>;
  borderColor: (nodeId: string) => string;
}

export function buildGraph(state: VizState): RenderGraph {
  const { nodes: rawNodes, edges: rawEdges } = state.graphData;

  state.nodeMeta = new Map(rawNodes.map(n => [n.id, n]));
  state.childrenByParent = new Map();
  for (const n of rawNodes) {
    if (!n.parent) continue;
    if (!state.childrenByParent.has(n.parent)) state.childrenByParent.set(n.parent, []);
    state.childrenByParent.get(n.parent)!.push(n);
  }
  state.changedEdgeIds = new Set<string>();
  for (const e of rawEdges) {
    if (e.status && e.status !== 'unchanged') {
      state.changedEdgeIds.add(e.src); state.changedEdgeIds.add(e.tar);
    }
  }

  const fileNodes = rawNodes.filter(n => !n.parent);

  const allNodes: any[] = [], allLinks: any[] = [], nodeById = new Map<string, any>();
  state.groupSymbols = new Map<string, any[]>();
  const containerDepth = new Map<string, number>();
  for (const n of fileNodes) containerDepth.set(n.id, 0);

  // Snapshot current positions so existing nodes don't jump
  const posCache = new Map<string, { x: number; y: number }>();
  if (state.simulation) {
    state.simulation.stop();
    for (const nd of state.simulation.nodes()) posCache.set(nd.id, { x: nd.x, y: nd.y });
  }
  const isFirstRender = posCache.size === 0;

  for (const n of fileNodes) {
    const pos = posCache.get(n.id);
    // depthScale(0) === 1, so every node — file or symbol — gets its scale from the
    // same formula instead of a hardcoded special case for files.
    const node = Object.assign({}, n, { _type: 'file', _scale: depthScale(0) });
    if (pos) { node.x = pos.x; node.y = pos.y; }
    allNodes.push(node); nodeById.set(n.id, node);
  }

  let frontier: { node: GraphNode; ancestors: string[] }[] = [];
  for (const n of fileNodes) {
    for (const child of visibleChildren(state.childrenByParent.get(n.id) ?? [], state.expandLevel.get(n.id) ?? 0, (id: string) => hasChangedEdge(id, state))) {
      frontier.push({ node: child, ancestors: [n.id] });
    }
  }
  while (frontier.length) {
    const next: { node: GraphNode; ancestors: string[] }[] = [];
    for (const { node: n, ancestors } of frontier) {
      const parentId = ancestors[ancestors.length - 1];
      const parent = nodeById.get(parentId);
      const ep = posCache.get(n.id);
      const sn = Object.assign({}, n, {
        _type: 'symbol', _parent: parentId, _scale: depthScale(ancestors.length),
        x: (ep && ep.x) || ((parent && parent.x) || 0) + (Math.random() - 0.5) * 60,
        y: (ep && ep.y) || ((parent && parent.y) || 0) + (Math.random() - 0.5) * 60,
      });
      allNodes.push(sn); nodeById.set(n.id, sn);
      containerDepth.set(n.id, ancestors.length);
      for (const a of ancestors) {
        if (!state.groupSymbols.has(a)) state.groupSymbols.set(a, []);
        state.groupSymbols.get(a)!.push(sn);
      }
      for (const child of visibleChildren(state.childrenByParent.get(n.id) ?? [], state.expandLevel.get(n.id) ?? 0, (id: string) => hasChangedEdge(id, state))) {
        next.push({ node: child, ancestors: [...ancestors, n.id] });
      }
    }
    frontier = next;
  }

  for (const e of buildLinks(rawNodes, rawEdges, state.expandLevel)) {
    allLinks.push({ source: e.src, target: e.tar, type: e.type, status: e.status, count: e.count });
  }

  const degreeMap = new Map<string, number>();
  const edgeStatusesByNode = new Map<string, Set<string>>();
  state.neighborsByNode = new Map<string, Set<string>>();
  function addEdgeStatus(nodeId: string, status: string | null | undefined) {
    if (!edgeStatusesByNode.has(nodeId)) edgeStatusesByNode.set(nodeId, new Set());
    edgeStatusesByNode.get(nodeId)!.add(status ?? 'unchanged');
  }
  function addNeighbor(a: string, b: string) {
    if (!state.neighborsByNode.has(a)) state.neighborsByNode.set(a, new Set());
    state.neighborsByNode.get(a)!.add(b);
  }
  for (const l of allLinks) {
    const s = l.source, t = l.target;
    degreeMap.set(s, (degreeMap.get(s) || 0) + 1);
    degreeMap.set(t, (degreeMap.get(t) || 0) + 1);
    addEdgeStatus(s, l.status);
    addEdgeStatus(t, l.status);
    addNeighbor(s, t);
    addNeighbor(t, s);
  }
  function borderColor(nodeId: string): string {
    return STATUS_COLOR[aggregateStatus(edgeStatusesByNode.get(nodeId) ?? new Set()) ?? 'unchanged'];
  }

  return { allNodes, allLinks, nodeById, containerDepth, isFirstRender, degreeMap, borderColor };
}
