// graph-client.ts - browser-side D3 force graph renderer.
// Served (after compilation + placeholder substitution) as /graph-client.js
// by viewer.mts. Loaded as a real ES module (<script type="module">) so it can
// share aggregate.mts's collapsing logic with the Node-side tests, rather than
// duplicating it.

import { buildLinks, visibleChildren, nextExpandLevel, aggregateStatus } from "./aggregate.mjs";
import type { GraphNode, GraphData } from "./types.mjs";

declare const d3: any;
// Substituted server-side (see renderClientJs in viewer.mts) before this
// script reaches the browser.
declare const __GRAPH_DATA__: GraphData;

// Single source of truth for every status colour and opacity in the UI — "unchanged"
// is just another status here, not a separate fallback constant. Node fill, symbol
// fill, tooltip badges, link strokes, hull layer, and the toolbar legend (wired up at
// the bottom of this file) all derive from these.
const STATUS_COLOR: Record<string, string> = { added: '#56d364', modified: '#e3b341', removed: '#f85149', unchanged: '#8b949e' };
const STATUS_OPACITY: Record<string, number> = { added: 0.35, modified: 0.35, removed: 0.30, unchanged: 0.45 };
function nodeStatus(d: any): string | null { return d.status ?? null; }
function nodeColor(d: any): string { return STATUS_COLOR[d.status ?? 'unchanged']; }
function symColor(d: any): string {
  return STATUS_COLOR[d.status ?? 'unchanged'];
}
function shortLabel(id: string): string { return (id ?? '').split('/').pop()!; }

function hullPath(pts: number[][], pad: number): string {
  if (!pts.length) return '';
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  if (pts.length < 3) {
    // An ellipse elongated along the line between the (1 or 2) points, rather than a
    // fixed-radius circle centered on their midpoint — a circle either fails to reach
    // two far-apart points or sits needlessly oversized around two close ones. The
    // minor axis is a factor of pad (not an added constant), so it scales down with
    // pad at every depth instead of becoming relatively oversized when pad shrinks.
    // Degenerates to a circle of radius 1.2*pad when the points coincide or are close.
    const [p0, p1] = pts.length === 2 ? pts : [pts[0], pts[0]];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const a = Math.max(1.2 * pad, dist / 2 + pad); // semi-major, along the two points
    const b = 1.2 * pad;                            // semi-minor, across them
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const N = 24;
    const ellipse: number[][] = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI;
      const ex = a * Math.cos(t), ey = b * Math.sin(t);
      ellipse.push([cx + ex * cos - ey * sin, cy + ex * sin + ey * cos]);
    }
    return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(ellipse);
  }
  const hull = d3.polygonHull(pts) ?? pts;
  const padded = hull.map((p: number[]) => {
    const dx = p[0]-cx, dy = p[1]-cy, len = Math.sqrt(dx*dx+dy*dy) || 1;
    return [p[0]+(dx/len)*pad, p[1]+(dy/len)*pad];
  });
  return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(padded);
}

let graphData: GraphData = __GRAPH_DATA__;
// Per-container expand level: 0 (collapsed, default/absent) -> 1 (changed symbols only)
// -> 2 (every symbol, including unchanged). Keyed by any container's id — a file, or
// (once nested) a class/interface — not just files. See aggregate.mts's nextExpandLevel.
let expandLevel = new Map<string, number>();
let showIsolated = true;
let simulation: any = null;

// Rebuilt at the top of every render() from the full (not just visible) node
// list, so collapsed/never-expanded symbols can still be resolved.
let nodeMeta = new Map<string, GraphNode>();
let childrenByParent = new Map<string, GraphNode[]>();
// Rebuilt each render(); read by the hover-focus logic below (focusNode/clearFocus),
// which runs later, on mouseenter/mouseleave — so these need to survive past the
// render() call that built them, not just live as locals inside it.
let groupSymbols = new Map<string, any[]>();
let neighborsByNode = new Map<string, Set<string>>();
let hullPaths = new Map<string, any>();
// Ids touching at least one changed (non-"unchanged") edge, rebuilt once per render
// from rawEdges — the same signal aggregate.mts's buildLinks uses internally, kept
// here too so symbolCounts/visibleChildren-in-graph-client agree with it on what's
// "edge-changed" for expand-tier purposes.
let changedEdgeIds = new Set<string>();
function hasChangedEdge(id: string): boolean { return changedEdgeIds.has(id); }

// Own-changed/edge-changed/fully-unchanged/total counts for a container's direct
// children, used to decide the next expand level and to show a "+N hidden" badge.
function symbolCounts(containerId: string): { ownChanged: number; edgeChanged: number; fullyUnchanged: number; total: number } {
  const children = childrenByParent.get(containerId) ?? [];
  let ownChanged = 0, edgeChanged = 0, fullyUnchanged = 0;
  for (const c of children) {
    if (c.status && c.status !== 'unchanged') ownChanged++;
    else if (hasChangedEdge(c.id)) edgeChanged++;
    else fullyUnchanged++;
  }
  return { ownChanged, edgeChanged, fullyUnchanged, total: children.length };
}

// How many of a container's direct children aren't currently shown, at its current expand level.
function hiddenCount(containerId: string): number {
  const { total } = symbolCounts(containerId);
  const level = expandLevel.get(containerId) ?? 0;
  const children = childrenByParent.get(containerId) ?? [];
  return total - visibleChildren(children, level, hasChangedEdge).length;
}

const svg = d3.select('#svg');
const root = d3.select('#root');
const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e: any) => root.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const defs = svg.append('defs');

// Toolbar legend colours, from the same STATUS_COLOR map — see graph.html for the markup.
(['added', 'modified', 'removed'] as const).forEach(status => {
  const el = document.getElementById('legend-' + status);
  if (el) el.style.color = STATUS_COLOR[status];
});

let linkSel: any, nodeSel: any, labelSel: any, gradientSel: any;

// A link's midpoint opacity as a fraction of its peak (source/target-end) opacity —
// each edge fades from both ends toward a faded middle instead of a flat
// stroke-opacity, so long lines crossing the canvas read as anchored at their nodes
// without adding clutter along the way.
const LINK_MID_FADE = 0.2;
// The fade ramp near each end is a fixed distance in px, not a fraction of the link's
// own length — otherwise a long edge fades gently over hundreds of px while a short
// one barely fades at all. Capped at 50% of the link's length so short links still
// meet cleanly in the middle rather than overshooting past each other.
const LINK_FADE_DISTANCE = 40;
function fadeStopOffsets(d: any): [number, number] {
  const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const frac = Math.min(0.5, LINK_FADE_DISTANCE / len);
  return [frac, 1 - frac];
}

// A file's collision radius before any depth scaling (a file is always depth 0, so
// this is also its actual radius). Every node's collision radius is this same base
// times depthScale(its own depth)² — no separate file/symbol formula. Squared because
// collision radius is a pure distance, not a glyph dimension: a glyph's felt "size" is
// its area (radius²), so a distance meant to track that felt size needs the same square.
const COLLISION_BASE_RADIUS = 48;

// Edge stroke-width as a function of how many raw edges it represents — rises with
// count but asymptotes rather than growing without bound, so one wildly-aggregated
// link can't visually swamp the graph. LINK_WIDTH_LIMIT (COLLISION_BASE_RADIUS / 3)
// is the width it approaches as count → ∞; LINK_WIDTH_HALF_COUNT is the count at
// which it's already at half that limit — a standard saturating (Michaelis-Menten
// shaped) curve, chosen so count 1 lands close to the old flat 1.2px default.
const LINK_WIDTH_LIMIT = COLLISION_BASE_RADIUS / 3;
const LINK_WIDTH_HALF_COUNT = 11;
function linkWidth(count: number): number {
  return LINK_WIDTH_LIMIT * count / (count + LINK_WIDTH_HALF_COUNT);
}

// Link strength per unit of count — see the 'link' force below.
const LINK_STRENGTH_PER_COUNT = 0.08;

function render() {
  const { nodes: rawNodes, edges: rawEdges } = graphData;
  document.getElementById('graph-title')!.textContent = graphData.title ?? 'Dependency Graph';
  if (!rawNodes || !rawNodes.length) {
    document.getElementById('empty')!.classList.add('show');
    document.getElementById('empty-msg')!.textContent = graphData.error ?? 'No graph loaded.';
    document.getElementById('stats')!.textContent = '';
    return;
  }
  document.getElementById('empty')!.classList.remove('show');

  nodeMeta = new Map(rawNodes.map(n => [n.id, n]));
  childrenByParent = new Map();
  for (const n of rawNodes) {
    if (!n.parent) continue;
    if (!childrenByParent.has(n.parent)) childrenByParent.set(n.parent, []);
    childrenByParent.get(n.parent)!.push(n);
  }
  changedEdgeIds = new Set<string>();
  for (const e of rawEdges) {
    if (e.status && e.status !== 'unchanged') { changedEdgeIds.add(e.src); changedEdgeIds.add(e.tar); }
  }

  const fileNodes = rawNodes.filter(n => !n.parent);

  const allNodes: any[] = [], allLinks: any[] = [], nodeById = new Map<string, any>();
  // containerId -> every visible descendant at ANY depth (not just direct children) —
  // used both to size a container's bounding hull around its whole subtree and to
  // exempt that whole subtree from being repelled by an ancestor container's boundary
  // (see forceGroup below). A class nested in an expanded file gets its own entry here
  // alongside the file's, so hulls nest visually the same way the containers do.
  groupSymbols = new Map<string, any[]>();
  // containerId -> its own nesting depth (0 for a file), so each container's hull can
  // pad itself down by the same depthScale() as its members' glyphs — an outer file
  // hull stays roomy, a hull nested a level deeper draws tighter around its contents.
  const containerDepth = new Map<string, number>();
  for (const n of fileNodes) containerDepth.set(n.id, 0);

  // Snapshot current positions so existing nodes don't jump
  const posCache = new Map<string, { x: number; y: number }>();
  if (simulation) {
    simulation.stop();
    for (const nd of simulation.nodes()) posCache.set(nd.id, { x: nd.x, y: nd.y });
  }
  const isFirstRender = posCache.size === 0;

  for (const n of fileNodes) {
    const pos = posCache.get(n.id);
    // _scale is set here too (depthScale(0) === 1) so every node — file or symbol —
    // carries a real, uniformly-computed scale; nothing downstream needs a `?? 1`
    // fallback to cover the file case specially.
    const node = Object.assign({}, n, { _type: 'file', _scale: depthScale(0) });
    if (pos) { node.x = pos.x; node.y = pos.y; }
    allNodes.push(node); nodeById.set(n.id, node);
  }

  // Breadth-first by depth, so shallower containers are always pushed (and painted)
  // before deeper ones — same order as before when nesting only ran one level deep,
  // just no longer capped there. Each frontier entry carries its full ancestor chain
  // so a node registers itself in every ancestor's (transitive) groupSymbols entry,
  // not just its immediate parent's.
  let frontier: { node: GraphNode; ancestors: string[] }[] = [];
  for (const n of fileNodes) {
    for (const child of visibleChildren(childrenByParent.get(n.id) ?? [], expandLevel.get(n.id) ?? 0, hasChangedEdge)) {
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
        if (!groupSymbols.has(a)) groupSymbols.set(a, []);
        groupSymbols.get(a)!.push(sn);
      }
      for (const child of visibleChildren(childrenByParent.get(n.id) ?? [], expandLevel.get(n.id) ?? 0, hasChangedEdge)) {
        next.push({ node: child, ancestors: [...ancestors, n.id] });
      }
    }
    frontier = next;
  }

  // ── Build effective link set ─────────────────────────────────────────────
  // buildLinks (aggregate.mts) resolves each edge against which files are expanded
  // and which symbols are actually visible, collapsing everything that lands on the
  // same (src, tar) pair — regardless of original edge type — into one summary edge.
  for (const e of buildLinks(rawNodes, rawEdges, expandLevel)) {
    allLinks.push({ source: e.src, target: e.tar, type: e.type, status: e.status, count: e.count });
  }

  // rawNodes/rawEdges are the full underlying graph; allNodes/allLinks are what's
  // actually shown at the current expand state (a subset once anything's collapsed,
  // and allLinks is further collapsed/aggregated on top of that — see buildLinks).
  document.getElementById('stats')!.textContent =
    `Nodes ${allNodes.length}/${rawNodes.length} · Edges ${allLinks.length}/${rawEdges.length}`;

  // Degree map for charge scaling, each node's incident-edge statuses for its border
  // colour, and each node's direct neighbours for hover-focus below — all read here
  // before D3 mutates source/target to objects.
  const degreeMap = new Map<string, number>();
  const edgeStatusesByNode = new Map<string, Set<string>>();
  neighborsByNode = new Map<string, Set<string>>();
  function addEdgeStatus(nodeId: string, status: string | null | undefined) {
    if (!edgeStatusesByNode.has(nodeId)) edgeStatusesByNode.set(nodeId, new Set());
    edgeStatusesByNode.get(nodeId)!.add(status ?? 'unchanged');
  }
  function addNeighbor(a: string, b: string) {
    if (!neighborsByNode.has(a)) neighborsByNode.set(a, new Set());
    neighborsByNode.get(a)!.add(b);
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
  // A node's border colour: the aggregate of every currently-rendered edge touching
  // it (same aggregateStatus() aggregate.mts uses to collapse several raw edges into
  // one link's status) — distinct from its fill, which is the node's OWN diff status.
  // Falls back to 'unchanged' grey for an isolated node with no edges at all.
  function borderColor(id: string): string {
    return STATUS_COLOR[aggregateStatus(edgeStatusesByNode.get(id) ?? new Set()) ?? 'unchanged'];
  }

  const w = svg.node().clientWidth || 800, h = svg.node().clientHeight || 600;

  function forceGroup(alpha: number) {
    const R_ATTRACT = 65, K_ATTRACT = 0.25;
    const GROUP_PAD = 35; // padding around group bounding circle

    // 1. Pull each symbol toward its parent. The leash is a pure distance, like the
    // collision radius, so it uses _scale² (not _scale) to shrink in step with the
    // symbol's felt (area) size rather than lagging behind its linear glyph radius.
    for (const nd of allNodes) {
      if (nd._type !== 'symbol') continue;
      const p = nodeById.get(nd._parent); if (!p) continue;
      const ndScale = nd._scale ?? 1;
      const leash = R_ATTRACT * ndScale * ndScale;
      const dx = nd.x - p.x, dy = nd.y - p.y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
      if (dist > leash) {
        const pull = (dist - leash) / dist * K_ATTRACT * alpha;
        nd.vx -= dx * pull; nd.vy -= dy * pull;
      }
    }

    // 2. Compute each group's bounding circle and repel external nodes from it
    for (const [parentId, syms] of groupSymbols) {
      const parent = nodeById.get(parentId); if (!parent) continue;
      const memberIds = new Set([parentId, ...syms.map(s => s.id)]);

      // Centroid of parent + all its symbols
      let cx = parent.x, cy = parent.y;
      for (const s of syms) { cx += s.x; cy += s.y; }
      cx /= (1 + syms.length); cy /= (1 + syms.length);

      // Bounding radius: max distance from centroid to any member
      let maxR = Math.sqrt((parent.x-cx)**2 + (parent.y-cy)**2);
      for (const s of syms) {
        const r = Math.sqrt((s.x-cx)**2 + (s.y-cy)**2);
        if (r > maxR) maxR = r;
      }
      const groupR = maxR + GROUP_PAD;

      // Repel all non-member nodes outside the bounding circle
      for (const nd of allNodes) {
        if (memberIds.has(nd.id)) continue;
        const dx = nd.x - cx, dy = nd.y - cy;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;
        if (dist < groupR) {
          const strength = ((groupR - dist) / groupR) * 1.2 * alpha;
          nd.vx += (dx / dist) * strength * groupR;
          nd.vy += (dy / dist) * strength * groupR;
        }
      }
    }
  }

  simulation = d3.forceSimulation(allNodes)
    .force('link', d3.forceLink(allLinks).id((d: any) => d.id)
      .distance((d: any) => d.type === 'sibling' ? 30 : d.type === 'import' ? 55 : 70)
      // Weighted by how many raw edges this rendered link represents, not by edge
      // type — a link standing in for 5 collapsed relationships pulls 5x harder than
      // one standing in for a single relationship. LINK_STRENGTH_PER_COUNT (0.08)
      // matches the old default call/reference strength at count 1, so the common
      // (uncollapsed) case is unchanged.
      .strength((d: any) => LINK_STRENGTH_PER_COUNT * (d.count ?? 1)))
    .force('charge', d3.forceManyBody().strength((d: any) => {
      if (d._type === 'symbol') return -40;
      const deg = degreeMap.get(d.id) || 0;
      return -(100 + deg * 28);
    }))
    .force('center', isFirstRender ? d3.forceCenter(w/2, h/2) : null)
    .force('gx', d3.forceX(w/2).strength(0.015))
    .force('gy', d3.forceY(h/2).strength(0.015))
    // One formula for every node, no file/symbol branch: collision radius is always
    // COLLISION_BASE_RADIUS * d._scale². A file is depth 0 (_scale 1) so it keeps its
    // existing radius. d._scale is a LINEAR shrink factor on the glyph's radius, but a
    // glyph's felt "size" is its AREA — radius² — so a pure-distance quantity like
    // collision radius has to use _scale² to shrink in step with how much smaller the
    // glyph actually looks, not lag behind it the way a linear factor alone would.
    .force('collision', d3.forceCollide((d: any) => COLLISION_BASE_RADIUS * d._scale * d._scale))
    .force('grouping', forceGroup)
    .alpha(isFirstRender ? 1 : 0.3)
    .restart();

  root.selectAll('.hull-layer').remove();
  const hullLayer = root.insert('g', ':first-child').attr('class', 'hull-layer');
  hullPaths = new Map<string, any>();
  for (const pid of groupSymbols.keys()) {
    const col = hullColor(containerDepth.get(pid) ?? 0);
    // pointer-events is left at its default (painted area is hoverable) rather than
    // 'none', so hovering the fuzzy container area itself — not just its node glyph —
    // triggers focusContainerArea's stricter highlighting (see its comment) for this
    // hull's own container id. Nested hulls are appended shallowest-first (see
    // groupSymbols' insertion order), so a more deeply nested hull paints on top and
    // correctly wins the hover in the region where it overlaps its ancestor's.
    hullPaths.set(pid, hullLayer.append('path')
      .style('fill', col).style('fill-opacity', '0.07')
      .style('stroke', col).style('stroke-opacity', '0.35')
      .style('stroke-width', '1.5')
      .on('mouseenter', () => focusContainerArea(pid))
      .on('mouseleave', () => clearFocus()));
  }

  // A gradient per link (userSpaceOnUse, positioned to the line's actual endpoints
  // on every tick below) carrying the fade: full peak opacity at both the source and
  // target ends, ramping down over LINK_FADE_DISTANCE px to a faded plateau covering
  // whatever length remains in the middle. Rebuilt each render alongside the links
  // themselves, in the same allLinks order/index so each line's stroke can reference
  // its gradient by index.
  defs.selectAll('.link-gradient').remove();
  gradientSel = defs.selectAll('.link-gradient').data(allLinks).join('linearGradient')
    .attr('class', 'link-gradient')
    .attr('id', (_d: any, i: number) => 'link-grad-' + i)
    .attr('gradientUnits', 'userSpaceOnUse')
    .each(function (this: any, d: any) {
      const col = STATUS_COLOR[d.status ?? 'unchanged'];
      const peak = STATUS_OPACITY[d.status ?? 'unchanged'];
      const [f1, f2] = fadeStopOffsets(d);
      const g = d3.select(this);
      g.append('stop').attr('offset', '0%').attr('stop-color', col).attr('stop-opacity', peak);
      g.append('stop').attr('class', 'stop-fade-in').attr('offset', (f1 * 100) + '%').attr('stop-color', col).attr('stop-opacity', peak * LINK_MID_FADE);
      g.append('stop').attr('class', 'stop-fade-out').attr('offset', (f2 * 100) + '%').attr('stop-color', col).attr('stop-opacity', peak * LINK_MID_FADE);
      g.append('stop').attr('offset', '100%').attr('stop-color', col).attr('stop-opacity', peak);
    });

  // Remove stale wrapper groups (not just their contents) and recreate them
  // links-then-nodes, so nodes always paint on top of edges.
  root.selectAll('.links').remove();
  linkSel = root.append('g').attr('class', 'links')
    .selectAll('line').data(allLinks).join('line')
    .attr('class', (d: any) => {
      const st = d.status && d.status !== 'unchanged' ? ' ' + d.status : '';
      return 'link' + st;
    })
    .attr('stroke', (_d: any, i: number) => 'url(#link-grad-' + i + ')')
    .attr('stroke-width', (d: any) => linkWidth(d.count ?? 1))
    .on('mouseenter', (e: any, d: any) => { showLinkTooltip(e, d); focusEdge(d); })
    .on('mouseleave', () => { tooltip.classList.remove('visible'); clearFocus(); });

  root.selectAll('.nodes').remove();
  nodeSel = root.append('g').attr('class', 'nodes')
    .selectAll('g').data(allNodes).join('g')
    .attr('class', (d: any) => (d._type === 'symbol' ? 'symbol-node' : 'node') + (expandable(d) ? ' expandable' : ''))
    .call(d3.drag()
      .on('start', (e: any, d: any) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e: any, d: any) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e: any, d: any) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('dblclick', (e: any, d: any) => { e.stopPropagation(); handleDblClick(d); })
    .on('mouseenter', (e: any, d: any) => { showTooltip(e, d); focusNode(d.id); })
    .on('mouseleave', () => { tooltip.classList.remove('visible'); clearFocus(); });

  nodeSel.filter((d: any) => d._type === 'file').append('circle')
    .attr('r', 10).attr('fill', (d: any) => nodeColor(d))
    .attr('stroke', (d: any) => borderColor(d.id)).attr('stroke-width', 2);

  nodeSel.filter((d: any) => d._type === 'symbol').each(function (this: any, d: any) {
    const g = d3.select(this);
    const col = symColor(d);
    const border = borderColor(d.id);
    const sh = symShape(d);
    const s = d._scale ?? 1;
    if (sh === 'triangle') {
      g.append('polygon').attr('points', `0,${-8*s} ${7*s},${5*s} ${-7*s},${5*s}`)
        .attr('fill', col).attr('stroke', border).attr('stroke-width', 2*s);
    } else if (sh === 'square') {
      // Same nominal radius (7) as the circle/triangle branches, so a class glyph
      // isn't visibly smaller than a function/property glyph at the same depth.
      g.append('rect').attr('x', -7*s).attr('y', -7*s).attr('width', 14*s).attr('height', 14*s).attr('rx', 1)
        .attr('fill', col).attr('stroke', border).attr('stroke-width', 2*s);
    } else {
      g.append('circle').attr('r', 7*s)
        .attr('fill', col).attr('stroke', border).attr('stroke-width', 2*s);
    }
  });

  // A badge inside the container's own <g> (not the labels group, so it moves with the
  // node without needing its own tick tracking) communicates what double-clicking does
  // next: "+N" when there's more to reveal, "-" when there's nothing left and it'll
  // collapse. Shown on any expandable node — a file, or a container symbol like a class.
  // Appended last (after every node's own shape above) so it always paints on top,
  // rather than being covered by a symbol's own circle/rect/triangle. Scaled by the
  // same _scale as its owning node's glyph (1 for a file, shrinking with depth for
  // everything nested under it), so a class's badge and a method's badge shrink in
  // step with the shapes they're attached to instead of all being one fixed size.
  nodeSel.filter((d: any) => expandable(d)).each(function (this: any, d: any) {
    const level = expandLevel.get(d.id) ?? 0;
    const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(d.id);
    const hidden = hiddenCount(d.id);
    const collapsesNext = level > 0 && nextExpandLevel(level, ownChanged, edgeChanged, fullyUnchanged) === 0;
    if (hidden <= 0 && !collapsesNext) return;

    const g = d3.select(this);
    const s = d._scale ?? 1;
    const cx = 7*s, cy = 7*s;
    g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 7*s)
      .attr('fill', '#30363d').attr('stroke', '#7d8590').attr('stroke-width', 1);
    g.append('text').attr('x', cx).attr('y', cy).attr('text-anchor', 'middle')
      .style('font-size', (9*s) + 'px').style('fill', '#adbac7').style('pointer-events', 'none').style('dominant-baseline', 'central')
      .text(hidden > 0 ? '+' + hidden : '-');
  });

  // Labels get their own top-level group, appended after .nodes, so every
  // label always renders in front of every node (not just its own).
  root.selectAll('.labels').remove();
  labelSel = root.append('g').attr('class', 'labels')
    .selectAll('text').data(allNodes).join('text')
    .attr('class', (d: any) => 'label ' + (d._type === 'symbol' ? 'symbol' : 'file'))
    .attr('x', 0).attr('y', -14).attr('text-anchor', 'middle')
    .text((d: any) => d.label ?? shortLabel(d.id));

  simulation.on('tick', () => {
    linkSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
            .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
    // userSpaceOnUse gradients are positioned in absolute coordinates, so each one
    // has to track its line's endpoints every tick, same as the line itself above.
    // The fade-in/out stop offsets are also recomputed every tick: they encode a
    // FIXED pixel distance from each end (LINK_FADE_DISTANCE), and a link's on-screen
    // length keeps changing as the simulation moves its endpoints.
    gradientSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
               .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y)
               .each(function (this: any, d: any) {
                 const [f1, f2] = fadeStopOffsets(d);
                 const g = d3.select(this);
                 g.select('.stop-fade-in').attr('offset', (f1 * 100) + '%');
                 g.select('.stop-fade-out').attr('offset', (f2 * 100) + '%');
               });
    nodeSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    labelSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    groupSymbols.forEach((syms, pid) => {
      const p = nodeById.get(pid);
      if (!p) return;
      // Squared for the same reason the collision radius and parent-leash are: pad is
      // a pure distance, so it should shrink with the container's felt (area) size.
      const containerScale = depthScale(containerDepth.get(pid) ?? 0);
      const pad = HULL_BASE_PAD * containerScale * containerScale;
      hullPaths.get(pid).attr('d', hullPath([[p.x, p.y]].concat(syms.map(s => [s.x, s.y])), pad));
    });
  });
}

function symShape(d: any): string {
  const k = d.type ?? '';
  if (k === 'function' || k === 'method') return 'triangle';
  if (k === 'class' || k === 'interface' || k === 'type' || k === 'enum') return 'square';
  return 'circle'; // property, const, field, unknown
}

// Each level of nesting shrinks a symbol's glyph and badge by this fraction relative
// to its parent, down to a floor so deep nesting never becomes unreadable: a class
// (depth 1) is smaller than its file, a method (depth 2) smaller still than its class.
const CHILD_SCALE_STEP = 0.78;
const CHILD_SCALE_FLOOR = 0.5;
function depthScale(depth: number): number {
  return Math.max(CHILD_SCALE_FLOOR, Math.pow(CHILD_SCALE_STEP, depth));
}

// A container's hull padding is HULL_BASE_PAD * depthScale(its own depth)² — squared
// for the same reason the collision radius is — wider than a single node's own glyph
// scaling at the outermost (file) level, then shrinking so a hull nested a level
// deeper draws tighter around its (already smaller) contents instead of carrying the
// same fixed padding as its parent's hull.
const HULL_BASE_PAD = 36;

// Hull colour: a dark blue at the outermost (file) level, lightening toward white at
// each deeper level — reuses the same depthScale() everything else scales by (as the
// fraction lightened, 1 - depthScale) so a class's hull and a method's hull get
// progressively lighter in the same proportion their padding shrinks.
const HULL_BASE_COLOR = '#1d4e89';
function hullColor(depth: number): string {
  return d3.interpolateRgb(HULL_BASE_COLOR, '#ffffff')(1 - depthScale(depth));
}

// A node is expandable if it has any (direct) children at all, changed or not —
// true for a file, and equally for a container symbol like a class once it has
// children of its own.
function expandable(d: any): boolean {
  return symbolCounts(d.id).total > 0;
}

const HOVER_DIM_OPACITY = 0.12;

// Every id "related" to a hovered node's own GLYPH, for dimming purposes: itself, its
// direct neighbours (via a currently-rendered edge), its ancestor chain (the
// container(s) it lives inside — so you can still see which file/class you're in),
// and its own members if it's itself a container. Applies uniformly regardless of
// node kind — hovering a class's glyph is exactly as generous as hovering a method's.
function relatedNodeIds(hoveredId: string): Set<string> {
  const related = new Set<string>([hoveredId]);
  for (const n of (neighborsByNode.get(hoveredId) ?? [])) related.add(n);
  for (let cur = nodeMeta.get(hoveredId); cur?.parent; cur = nodeMeta.get(cur.parent)) related.add(cur.parent);
  for (const desc of (groupSymbols.get(hoveredId) ?? [])) related.add(desc.id);
  return related;
}

// A hovered id's own ancestor chain, plus itself — the containers that actually
// contain it. Used two ways: (1) as the set of hulls that stay bright no matter which
// of the above two hover modes triggered — a container should only stay bright
// because the hovered thing lives inside it, never because it merely contains some
// other related node; (2) as the *entire* related set when hovering a container's
// AREA (its hull) rather than its glyph — see focusContainerArea.
function ancestorIds(hoveredId: string): Set<string> {
  const ancestors = new Set<string>([hoveredId]);
  for (let cur = nodeMeta.get(hoveredId); cur?.parent; cur = nodeMeta.get(cur.parent)) ancestors.add(cur.parent);
  return ancestors;
}

// Shared dimming mechanics for both hover modes below: nodeRelated decides which
// nodes/labels stay bright, hullRelated which container hulls do, edgeIsBright which
// links do. Everything else darkens to HOVER_DIM_OPACITY.
//
// A link also loses its fade-toward-midpoint gradient for the duration of any hover —
// both when highlighted and when dimmed, it renders as a flat, evenly-opaque line
// (at its normal peak status opacity, then further scaled by the opacity toggle below
// if dimmed) instead of the gradient's varying one. clearFocus() restores the gradient.
function applyDimming(nodeRelated: Set<string>, hullRelated: Set<string>, edgeIsBright: (d: any) => boolean) {
  nodeSel.style('opacity', (d: any) => nodeRelated.has(d.id) ? null : HOVER_DIM_OPACITY);
  labelSel.style('opacity', (d: any) => nodeRelated.has(d.id) ? null : HOVER_DIM_OPACITY);
  linkSel
    .attr('stroke', (d: any) => STATUS_COLOR[d.status ?? 'unchanged'])
    .attr('stroke-opacity', (d: any) => STATUS_OPACITY[d.status ?? 'unchanged'])
    .style('opacity', (d: any) => edgeIsBright(d) ? null : HOVER_DIM_OPACITY);
  hullPaths.forEach((path: any, containerId: string) => {
    path.style('opacity', hullRelated.has(containerId) ? null : HOVER_DIM_OPACITY);
  });
}

// Hovering a node's own glyph (file, class, or leaf symbol alike): the generous rule.
// An edge stays bright if it touches the hovered node directly, or touches one of its
// members when the hovered node is itself a container.
function focusNode(hoveredId: string) {
  const subtree = new Set<string>([hoveredId, ...(groupSymbols.get(hoveredId) ?? []).map((n: any) => n.id)]);
  applyDimming(relatedNodeIds(hoveredId), ancestorIds(hoveredId),
    (d: any) => subtree.has(d.source.id) || subtree.has(d.target.id));
}

// Hovering a container's AREA — its hull, not its glyph. Deliberately the strict
// rule: only the container itself and its ancestor chain light up, so you can quickly
// identify what contains it without every member or neighbour also staying bright.
// No edge stays bright in this mode, even one touching the container's own node —
// hovering the area is about the containment relationship, not the container's edges.
function focusContainerArea(containerId: string) {
  const ancestorsOrSelf = ancestorIds(containerId);
  applyDimming(ancestorsOrSelf, ancestorsOrSelf, () => false);
}

// Hovering an edge itself: only it and its two endpoint nodes stay bright — no
// ancestors, no hulls, nothing else. Tighter than either node-hover mode above.
// Identity (===) is enough to pick out "this exact edge" since d is the same object
// reference bound to linkSel throughout the current render.
function focusEdge(hovered: any) {
  applyDimming(new Set<string>([hovered.source.id, hovered.target.id]), new Set<string>(), (d: any) => d === hovered);
}

function clearFocus() {
  nodeSel.style('opacity', null);
  labelSel.style('opacity', null);
  linkSel.style('opacity', null).attr('stroke', (_d: any, i: number) => 'url(#link-grad-' + i + ')').attr('stroke-opacity', null);
  hullPaths.forEach((path: any) => path.style('opacity', null));
}

function handleDblClick(d: any) {
  if (!expandable(d)) return;
  const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(d.id);
  const next = nextExpandLevel(expandLevel.get(d.id) ?? 0, ownChanged, edgeChanged, fullyUnchanged);
  if (next === 0) expandLevel.delete(d.id); else expandLevel.set(d.id, next);
  render();
}

const tooltip = document.getElementById('tooltip')!;
// What double-clicking this container would do next, or '' if it's not expandable at all.
function expandHint(containerId: string): string {
  const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(containerId);
  const current = expandLevel.get(containerId) ?? 0;
  const next = nextExpandLevel(current, ownChanged, edgeChanged, fullyUnchanged);
  if (next === current) return '';
  if (next === 0) return 'double-click to collapse';
  if (next === 1) return 'double-click to expand (' + ownChanged + ' changed)';
  if (next === 2) return 'double-click to show ' + edgeChanged + ' with a changed edge';
  return 'double-click to show ' + fullyUnchanged + ' unchanged';
}

function showTooltip(event: MouseEvent, d: any) {
  const s = nodeStatus(d);
  const col = s ? STATUS_COLOR[s] : '';
  const badge = s ? ' <span style="color:' + col + ';font-weight:700">[' + s + ']</span>' : '';
  const hintText = expandable(d) ? expandHint(d.id) : '';
  const hint = hintText ? '<br>' + hintText : '';
  tooltip.innerHTML = '<strong>' + (d.label ?? shortLabel(d.id)) + '</strong><span class="meta">' +
    (d._type === 'symbol' ? (d.type || 'symbol') : 'file') + badge + hint + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}
function moveTooltip(e: MouseEvent) {
  const wrap = document.getElementById('canvas-wrap')!.getBoundingClientRect();
  let x = e.clientX - wrap.left + 12, y = e.clientY - wrap.top + 12;
  if (x + 310 > wrap.width) x -= 320;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}

function showLinkTooltip(event: MouseEvent, d: any) {
  const count: number = d.count ?? 1;
  const s = d.status && d.status !== 'unchanged' ? d.status : null;
  const col = s ? STATUS_COLOR[s] : '#7d8590';
  const badge = ' <span style="color:' + col + ';font-weight:700">[' + (s ?? 'unchanged') + ']</span>';
  const srcLabel = d.source?.label ?? shortLabel(d.source?.id ?? d.source);
  const tarLabel = d.target?.label ?? shortLabel(d.target?.id ?? d.target);
  const header = d.type + (count > 1 ? ' ×' + count : '');
  tooltip.innerHTML = '<strong>' + header + '</strong><span class="meta">' +
    srcLabel + ' &rarr; ' + tarLabel + badge + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}
svg.node().addEventListener('mousemove', (e: MouseEvent) => { if (tooltip.classList.contains('visible')) moveTooltip(e); });

function fitView() {
  const b = root.node().getBBox(); if (!b.width || !b.height) return;
  const w = svg.node().clientWidth || 800, h = svg.node().clientHeight || 600;
  const scale = Math.min(0.9, 0.9 / Math.max(b.width/w, b.height/h));
  const tx = w/2 - scale*(b.x + b.width/2), ty = h/2 - scale*(b.y + b.height/2);
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}
document.getElementById('btn-fit')!.addEventListener('click', fitView);
document.getElementById('btn-reset-expand')!.addEventListener('click', () => { expandLevel.clear(); render(); });

const evtSource = new EventSource('/events');
evtSource.onmessage = (e: MessageEvent) => {
  try { const d = JSON.parse(e.data); if (d.type === 'graph') { graphData = d.payload; render(); setTimeout(fitView, 600); } } catch (err) {}
};

render();
if (graphData.nodes && graphData.nodes.length > 0) setTimeout(fitView, 600);
