// types.mts - the graph data shape shared by the parser, the viewer's edge-collapsing
// logic, and the browser client. Deliberately has zero imports of its own (no Node
// built-ins, no treesitter) so it's safe to pull into any compilation — Node-side or
// browser — without dragging in anything else.

// A node is either a file (no parent) or a symbol (parent = its containing file's id).
// `type` is "file" for file nodes, or the symbol kind (function/method/class/...) for symbol nodes.
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  parent?: string;
  status?: string;
  // Never set by parsePr — populated by the viewer's D3 simulation once a node
  // is rendered, and reused as a position cache across re-renders.
  x?: number;
  y?: number;
}

export interface GraphEdge {
  src: string;
  tar: string;
  type: string;
  status?: string | null;
  // Number of underlying relationships this edge represents. Always 1 from parsePr —
  // aggregate.mts is what collapses several raw edges into one with count > 1.
  count: number;
}

export interface GraphData {
  title?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  error?: string;
}
