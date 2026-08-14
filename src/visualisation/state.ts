// state.ts - the mutable state shared across the visualisation modules, and a
// constructor for it.
import type { GraphNode, GraphData } from "../types.mjs";

export interface VizState {
  graphData: GraphData;
  // Per-container expand level: 0 (collapsed) -> 1 (own-status changed) -> 2 (+
  // unchanged children touching a changed edge) -> 3 (+ everything else). Keyed by
  // any container's id — a file, or (once nested) a class/interface.
  expandLevel: Map<string, number>;
  nodeMeta: Map<string, GraphNode>;
  childrenByParent: Map<string, GraphNode[]>;
  groupSymbols: Map<string, any[]>;
  neighborsByNode: Map<string, Set<string>>;
  hullPaths: Map<string, any>;
  changedEdgeIds: Set<string>;
  linkSel: any;
  nodeSel: any;
  labelSel: any;
  gradientSel: any;
  // Persists across render() calls on purpose, so buildGraph can read the previous
  // positions before replacing it.
  simulation: any;
}

export function createVizState(): VizState {
  return {
    graphData: { nodes: [], edges: [] },
    expandLevel: new Map(),
    nodeMeta: new Map(),
    childrenByParent: new Map(),
    groupSymbols: new Map(),
    neighborsByNode: new Map(),
    hullPaths: new Map(),
    changedEdgeIds: new Set(),
    linkSel: undefined,
    nodeSel: undefined,
    labelSel: undefined,
    gradientSel: undefined,
    simulation: null,
  };
}

export function hasChangedEdge(id: string, state: VizState): boolean {
  return state.changedEdgeIds.has(id);
}
