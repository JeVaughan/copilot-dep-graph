// graph-client.ts - browser-side D3 force graph renderer.
// Served (after compilation + placeholder substitution) as /graph-client.js
// by viewer.mts. Loaded as a real ES module (<script type="module">) so it can
// share aggregate.mts's collapsing logic with the Node-side tests, rather than
// duplicating it.

import { buildLinks, visibleChildren, nextExpandLevel } from "./aggregate.mjs";
import type { GraphNode, GraphData } from "./types.mjs";

declare const d3: any;
// Substituted server-side (see renderClientJs in viewer.mts) before this
// script reaches the browser.
declare const __GRAPH_DATA__: GraphData;

// Single source of truth for every status colour and opacity in the UI — "unchanged"
// is just another status here, not a separate fallback constant. Node fill, symbol
// fill, tooltip badges, arrow markers, link strokes, hull layer, and the toolbar
// legend (wired up at the bottom of this file) all derive from these.
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
    const r = pad + 20;
    return 'M ' + (cx-r) + ',' + cy + ' a' + r + ',' + r + ' 0 1,0 ' + (r*2) + ',0 a' + r + ',' + r + ' 0 1,0 -' + (r*2) + ',0';
  }
  const hull = d3.polygonHull(pts) ?? pts;
  const padded = hull.map((p: number[]) => {
    const dx = p[0]-cx, dy = p[1]-cy, len = Math.sqrt(dx*dx+dy*dy) || 1;
    return [p[0]+(dx/len)*pad, p[1]+(dy/len)*pad];
  });
  return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5))(padded);
}

let graphData: GraphData = __GRAPH_DATA__;
// Per-file expand level: 0 (collapsed, default/absent) -> 1 (changed symbols only)
// -> 2 (every symbol, including unchanged). See aggregate.mts's nextExpandLevel.
let expandLevel = new Map<string, number>();
let showIsolated = true;
let simulation: any = null;

// Rebuilt at the top of every render() from the full (not just visible) node
// list, so collapsed/never-expanded symbols can still be resolved.
let nodeMeta = new Map<string, GraphNode>();
let childrenByParent = new Map<string, GraphNode[]>();

// changed/unchanged/total counts for a file's symbol children, used to decide the
// next expand level and to show a "+N hidden" badge on the node.
function symbolCounts(fileId: string): { changed: number; unchanged: number; total: number } {
  const children = childrenByParent.get(fileId) ?? [];
  const changed = visibleChildren(children, 1).length;
  return { changed, unchanged: children.length - changed, total: children.length };
}

// How many of a file's symbols aren't currently shown, at its current expand level.
function hiddenCount(fileId: string): number {
  const { total } = symbolCounts(fileId);
  const level = expandLevel.get(fileId) ?? 0;
  return total - visibleChildren(childrenByParent.get(fileId) ?? [], level).length;
}

const svg = d3.select('#svg');
const root = d3.select('#root');
const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e: any) => root.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const defs = svg.append('defs');
// Opacity matches the corresponding link's stroke-opacity (set alongside .attr('stroke', ...)
// in render() below), so an arrowhead doesn't look like a solid, opaque cap on a faint line.
[
  { id: 'arrow', color: STATUS_COLOR.unchanged, opacity: STATUS_OPACITY.unchanged },
  { id: 'arrow-added', color: STATUS_COLOR.added, opacity: STATUS_OPACITY.added },
  { id: 'arrow-modified', color: STATUS_COLOR.modified, opacity: STATUS_OPACITY.modified },
  { id: 'arrow-removed', color: STATUS_COLOR.removed, opacity: STATUS_OPACITY.removed },
].forEach(({ id, color, opacity }) => {
  defs.append('marker')
    .attr('id', id).attr('viewBox', '0 -4 8 8')
    .attr('refX', 18).attr('refY', 0).attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color).attr('fill-opacity', opacity);
});

// Toolbar legend colours, from the same STATUS_COLOR map — see graph.html for the markup.
(['added', 'modified', 'removed'] as const).forEach(status => {
  const el = document.getElementById('legend-' + status);
  if (el) el.style.color = STATUS_COLOR[status];
});

let linkSel: any, nodeSel: any, labelSel: any;

function render() {
  const { nodes: rawNodes, edges: rawEdges } = graphData;
  document.getElementById('graph-title')!.textContent = graphData.title ?? 'Dependency Graph';
  if (!rawNodes || !rawNodes.length) {
    document.getElementById('empty')!.classList.add('show');
    document.getElementById('empty-msg')!.textContent = graphData.error ?? 'No graph loaded.';
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

  const fileNodes = rawNodes.filter(n => !n.parent);

  const allNodes: any[] = [], allLinks: any[] = [], nodeById = new Map<string, any>(), groupSymbols = new Map<string, any[]>();

  // Snapshot current positions so existing nodes don't jump
  const posCache = new Map<string, { x: number; y: number }>();
  if (simulation) {
    simulation.stop();
    for (const nd of simulation.nodes()) posCache.set(nd.id, { x: nd.x, y: nd.y });
  }
  const isFirstRender = posCache.size === 0;

  for (const n of fileNodes) {
    const pos = posCache.get(n.id);
    const node = Object.assign({}, n, { _type: 'file' });
    if (pos) { node.x = pos.x; node.y = pos.y; }
    allNodes.push(node); nodeById.set(n.id, node);
  }
  for (const n of fileNodes) {
    const cs = visibleChildren(childrenByParent.get(n.id) ?? [], expandLevel.get(n.id) ?? 0);
    if (cs.length) {
      const parent = nodeById.get(n.id);
      const group: any[] = [];
      for (const sym of cs) {
        const ep = posCache.get(sym.id);
        const sn = Object.assign({}, sym, {
          _type: 'symbol', _parent: n.id,
          x: (ep && ep.x) || ((parent && parent.x) || 0) + (Math.random() - 0.5) * 60,
          y: (ep && ep.y) || ((parent && parent.y) || 0) + (Math.random() - 0.5) * 60,
        });
        allNodes.push(sn); nodeById.set(sym.id, sn); group.push(sn);
      }
      groupSymbols.set(n.id, group);
    }
  }

  // ── Build effective link set ─────────────────────────────────────────────
  // buildLinks (aggregate.mts) resolves each edge against which files are expanded
  // and which symbols are actually visible, collapsing everything that lands on the
  // same (src, tar) pair — regardless of original edge type — into one summary edge.
  for (const e of buildLinks(rawNodes, rawEdges, expandLevel)) {
    allLinks.push({ source: e.src, target: e.tar, type: e.type, status: e.status, count: e.count });
  }

  // Degree map for charge scaling (read before D3 mutates source/target to objects)
  const degreeMap = new Map<string, number>();
  for (const l of allLinks) {
    const s = l.source, t = l.target;
    degreeMap.set(s, (degreeMap.get(s) || 0) + 1);
    degreeMap.set(t, (degreeMap.get(t) || 0) + 1);
  }

  const w = svg.node().clientWidth || 800, h = svg.node().clientHeight || 600;

  function forceGroup(alpha: number) {
    const R_ATTRACT = 65, K_ATTRACT = 0.25;
    const GROUP_PAD = 35; // padding around group bounding circle

    // 1. Pull each symbol toward its parent
    for (const nd of allNodes) {
      if (nd._type !== 'symbol') continue;
      const p = nodeById.get(nd._parent); if (!p) continue;
      const dx = nd.x - p.x, dy = nd.y - p.y, dist = Math.sqrt(dx*dx + dy*dy) || 1;
      if (dist > R_ATTRACT) {
        const pull = (dist - R_ATTRACT) / dist * K_ATTRACT * alpha;
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
      .strength((d: any) => d.type === 'sibling' ? 0.5 : d.type === 'import' ? 0.02 : (d._type === 'symbol' ? 0.35 : 0.08)))
    .force('charge', d3.forceManyBody().strength((d: any) => {
      if (d._type === 'symbol') return -40;
      const deg = degreeMap.get(d.id) || 0;
      return -(100 + deg * 28);
    }))
    .force('center', isFirstRender ? d3.forceCenter(w/2, h/2) : null)
    .force('gx', d3.forceX(w/2).strength(0.015))
    .force('gy', d3.forceY(h/2).strength(0.015))
    .force('collision', d3.forceCollide((d: any) => d._type === 'symbol' ? 20 : 48))
    .force('grouping', forceGroup)
    .alpha(isFirstRender ? 1 : 0.3)
    .restart();

  root.selectAll('.hull-layer').remove();
  const hullLayer = root.insert('g', ':first-child').attr('class', 'hull-layer');
  const hullPaths = new Map<string, any>();
  for (const pid of groupSymbols.keys()) {
    hullPaths.set(pid, hullLayer.append('path')
      .style('fill', STATUS_COLOR.unchanged).style('fill-opacity', '0.07')
      .style('stroke', STATUS_COLOR.unchanged).style('stroke-opacity', '0.35')
      .style('stroke-width', '1.5').style('pointer-events', 'none'));
  }

  // Remove stale wrapper groups (not just their contents) and recreate them
  // links-then-nodes, so nodes always paint on top of edges.
  root.selectAll('.links').remove();
  linkSel = root.append('g').attr('class', 'links')
    .selectAll('line').data(allLinks).join('line')
    .attr('class', (d: any) => {
      const st = d.status && d.status !== 'unchanged' ? ' ' + d.status : '';
      return 'link' + st;
    })
    .attr('stroke', (d: any) => STATUS_COLOR[d.status ?? 'unchanged'])
    .attr('stroke-opacity', (d: any) => STATUS_OPACITY[d.status ?? 'unchanged'])
    .attr('stroke-dasharray', (d: any) => d.status === 'removed' ? '5,3' : null)
    .attr('marker-end', (d: any) => {
      const s = d.status && d.status !== 'unchanged' ? d.status : null;
      return s ? 'url(#arrow-' + s + ')' : 'url(#arrow)';
    })
    .on('mouseenter', (e: any, d: any) => showLinkTooltip(e, d))
    .on('mouseleave', () => tooltip.classList.remove('visible'));

  root.selectAll('.nodes').remove();
  nodeSel = root.append('g').attr('class', 'nodes')
    .selectAll('g').data(allNodes).join('g')
    .attr('class', (d: any) => (d._type === 'symbol' ? 'symbol-node' : 'node') + (expandable(d) ? ' expandable' : ''))
    .call(d3.drag()
      .on('start', (e: any, d: any) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e: any, d: any) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e: any, d: any) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('dblclick', (e: any, d: any) => { e.stopPropagation(); handleDblClick(d); })
    .on('mouseenter', (e: any, d: any) => showTooltip(e, d))
    .on('mouseleave', () => tooltip.classList.remove('visible'));

  nodeSel.filter((d: any) => d._type === 'file').append('circle')
    .attr('r', 10).attr('fill', (d: any) => nodeColor(d)).attr('stroke', 'none');

  // A badge inside the file's own <g> (not the labels group, so it moves with the node
  // without needing its own tick tracking) communicates what double-clicking does next:
  // "+N" when there's more to reveal, "-" when there's nothing left and it'll collapse.
  nodeSel.filter((d: any) => d._type === 'file').each(function (this: any, d: any) {
    const level = expandLevel.get(d.id) ?? 0;
    const { changed, unchanged } = symbolCounts(d.id);
    const hidden = hiddenCount(d.id);
    const collapsesNext = level > 0 && nextExpandLevel(level, changed, unchanged) === 0;
    if (hidden <= 0 && !collapsesNext) return;

    const g = d3.select(this);
    const cx = 7, cy = 7;
    g.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 7)
      .attr('fill', '#30363d').attr('stroke', '#7d8590').attr('stroke-width', 1);
    g.append('text').attr('x', cx).attr('y', cy).attr('text-anchor', 'middle')
      .style('font-size', '9px').style('fill', '#adbac7').style('pointer-events', 'none').style('dominant-baseline', 'central')
      .text(hidden > 0 ? '+' + hidden : '-');
  });

  nodeSel.filter((d: any) => d._type === 'symbol').each(function (this: any, d: any) {
    const g = d3.select(this);
    const col = symColor(d);
    const sh = symShape(d);
    if (sh === 'triangle') {
      g.append('polygon').attr('points', '0,-8 7,5 -7,5')
        .attr('fill', col).attr('stroke', col).attr('stroke-width', 1);
    } else if (sh === 'square') {
      g.append('rect').attr('x', -6).attr('y', -6).attr('width', 12).attr('height', 12).attr('rx', 1)
        .attr('fill', col).attr('stroke', col).attr('stroke-width', 1);
    } else {
      g.append('circle').attr('r', 7)
        .attr('fill', col).attr('stroke', col).attr('stroke-width', 1);
    }
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
    nodeSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    labelSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    groupSymbols.forEach((syms, pid) => {
      const p = nodeById.get(pid);
      if (p) hullPaths.get(pid).attr('d', hullPath([[p.x, p.y]].concat(syms.map(s => [s.x, s.y])), 22));
    });
  });
}

function symShape(d: any): string {
  const k = d.type ?? '';
  if (k === 'function' || k === 'method') return 'triangle';
  if (k === 'class' || k === 'interface' || k === 'type' || k === 'enum') return 'square';
  return 'circle'; // property, const, field, unknown
}

// A file node is expandable if it has any symbol children at all (changed or not).
function expandable(d: any): boolean {
  return d._type === 'file' && symbolCounts(d.id).total > 0;
}

function handleDblClick(d: any) {
  if (!expandable(d)) return;
  const { changed, unchanged } = symbolCounts(d.id);
  const next = nextExpandLevel(expandLevel.get(d.id) ?? 0, changed, unchanged);
  if (next === 0) expandLevel.delete(d.id); else expandLevel.set(d.id, next);
  render();
}

const tooltip = document.getElementById('tooltip')!;
// What double-clicking this file would do next, or '' if it's not expandable at all.
function expandHint(fileId: string): string {
  const { changed, unchanged } = symbolCounts(fileId);
  const current = expandLevel.get(fileId) ?? 0;
  const next = nextExpandLevel(current, changed, unchanged);
  if (next === current) return '';
  if (next === 0) return 'double-click to collapse';
  if (next === 1) return 'double-click to expand (' + changed + ' changed)';
  return 'double-click to show ' + unchanged + ' unchanged';
}

function showTooltip(event: MouseEvent, d: any) {
  const s = nodeStatus(d);
  const col = s ? STATUS_COLOR[s] : '';
  const badge = s ? ' <span style="color:' + col + ';font-weight:700">[' + s + ']</span>' : '';
  const hintText = d._type === 'file' ? expandHint(d.id) : '';
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
