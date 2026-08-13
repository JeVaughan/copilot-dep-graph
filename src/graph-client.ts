// graph-client.ts - browser-side D3 force graph renderer.
// Served (after compilation + placeholder substitution) as /graph-client.js
// by extension.mts. Runs in the canvas iframe with no bundler — plain script,
// no imports/exports.

declare const d3: any;
// Substituted server-side (see renderClientJs in viewer.mts) before this
// script reaches the browser.
declare const __GRAPH_DATA__: GraphData;

interface GraphSymbol {
  name: string;
  kind?: string;
  status?: string;
  signature?: string;
  [key: string]: any;
}

interface GraphNode {
  id: string;
  label?: string;
  path?: string;
  status?: string;
  symbols?: GraphSymbol[];
  signature?: string;
  kind?: string;
  [key: string]: any;
}

interface GraphLink {
  source: string;
  target: string;
  status?: string | null;
  _linkType: string;
  sourceFile?: string;
  targetFile?: string;
  [key: string]: any;
}

interface GraphData {
  title?: string;
  error?: string;
  nodes: GraphNode[];
  links: GraphLink[];
}

const STATUS_COLOR: Record<string, string> = { added: '#56d364', modified: '#e3b341', removed: '#f85149' };
const NODE_NEUTRAL = '#8b949e';
function nodeStatus(d: any): string | null { return d.status ?? null; }
function nodeColor(d: any): string { return d.status ? STATUS_COLOR[d.status] : NODE_NEUTRAL; }
function symColor(d: any): string {
  const s = d.status && d.status !== 'unchanged' ? d.status : d._parentStatus;
  return (s && s !== 'unchanged') ? STATUS_COLOR[s] : '#8b949e';
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
let expandedNodes = new Set<string>();
let showIsolated = true;
let simulation: any = null;
const svg = d3.select('#svg');
const root = d3.select('#root');
const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e: any) => root.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
const defs = svg.append('defs');
[
  { id: 'arrow', color: '#8b949e' },
  { id: 'arrow-added', color: '#56d364' },
  { id: 'arrow-modified', color: '#e3b341' },
  { id: 'arrow-removed', color: '#f85149' },
].forEach(({ id, color }) => {
  defs.append('marker')
    .attr('id', id).attr('viewBox', '0 -4 8 8')
    .attr('refX', 18).attr('refY', 0).attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color);
});

let linkSel: any, nodeSel: any;

function render() {
  const { nodes: rawAll, links: rawLinks } = graphData;
  document.getElementById('graph-title')!.textContent = graphData.title ?? 'Dependency Graph';
  if (!rawAll || !rawAll.length) {
    document.getElementById('empty')!.classList.add('show');
    document.getElementById('empty-msg')!.textContent = graphData.error ?? 'No graph loaded.';
    return;
  }
  document.getElementById('empty')!.classList.remove('show');

  const raw = rawAll;

  const allNodes: any[] = [], allLinks: any[] = [], nodeById = new Map<string, any>(), groupSymbols = new Map<string, any[]>();

  // Snapshot current positions so existing nodes don't jump
  const posCache = new Map<string, { x: number; y: number }>();
  if (simulation) {
    simulation.stop();
    for (const nd of simulation.nodes()) posCache.set(nd.id, { x: nd.x, y: nd.y });
  }
  const isFirstRender = posCache.size === 0;

  for (const n of raw) {
    const pos = posCache.get(n.id);
    const node = Object.assign({}, n, { _type: 'file', _expanded: expandedNodes.has(n.id) });
    if (pos) { node.x = pos.x; node.y = pos.y; }
    allNodes.push(node); nodeById.set(n.id, node);
  }
  for (const n of raw) {
    // Only show symbols that actually changed (signature or body diff)
    const cs = changedSymbols(n);
    if (expandedNodes.has(n.id) && cs.length) {
      const parent = nodeById.get(n.id);
      const group: any[] = [];
      for (const sym of cs) {
        const sid = n.id + ':::' + sym.name;
        const ep = posCache.get(sid);
        const sn = {
          id: sid, label: sym.name, kind: sym.kind, status: sym.status, _type: 'symbol', _parent: n.id,
          _parentStatus: n.status,
          x: (ep && ep.x) || ((parent && parent.x) || 0) + (Math.random() - 0.5) * 60,
          y: (ep && ep.y) || ((parent && parent.y) || 0) + (Math.random() - 0.5) * 60
        };
        allNodes.push(sn); nodeById.set(sid, sn); group.push(sn);
      }
      groupSymbols.set(n.id, group);
    }
  }

  // ── Build effective link set ─────────────────────────────────────────────
  const nodeIdSet = new Set(allNodes.map(n => n.id));

  // Import links: always file→file, never follow expansion
  for (const lk of rawLinks) {
    if (lk._linkType !== 'import') continue;
    if (nodeIdSet.has(lk.source) && nodeIdSet.has(lk.target)) allLinks.push(Object.assign({}, lk));
  }

  // Sibling links: structural connectors between co-located component files (.ts/.html/.scss)
  for (const lk of rawLinks) {
    if (lk._linkType !== 'sibling') continue;
    if (nodeIdSet.has(lk.source) && nodeIdSet.has(lk.target)) allLinks.push(Object.assign({}, lk));
  }
  //   neither expanded:    fileA → fileB
  //   source expanded:     sym → fileB  (falls back to fileA if sym not shown)
  //   both expanded:       sym → sym    (falls back to file if either sym not shown)
  const callLinkKeys = new Set<string>();
  for (const lk of rawLinks) {
    if (lk._linkType !== 'call') continue;
    // Resolve source: prefer symbol node if file expanded and symbol is visible, else stay on file
    const srcSym = lk.sourceFile && expandedNodes.has(lk.sourceFile) && nodeIdSet.has(lk.source) ? lk.source : null;
    const tgtSym = lk.targetFile && expandedNodes.has(lk.targetFile) && nodeIdSet.has(lk.target) ? lk.target : null;
    const src = srcSym ?? lk.sourceFile;
    const tgt = tgtSym ?? lk.targetFile;
    if (!src || !tgt || src === tgt) continue;
    if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue;
    const key = src + '->' + tgt;
    if (callLinkKeys.has(key)) continue;
    callLinkKeys.add(key);
    // Symbol-level status takes priority; fall back to file status for unchanged symbols
    const srcFileNode = nodeById.get(lk.sourceFile!);
    const tgtFileNode = nodeById.get(lk.targetFile!);
    const callStatus = (lk.status && lk.status !== 'unchanged') ? lk.status
                     : srcFileNode?.status ?? tgtFileNode?.status ?? null;
    allLinks.push({ source: src, target: tgt, _linkType: 'call', status: callStatus });
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
      .distance((d: any) => d._linkType === 'sibling' ? 30 : d._linkType === 'import' ? 55 : 70)
      .strength((d: any) => d._linkType === 'sibling' ? 0.5 : d._linkType === 'import' ? 0.02 : (d._type === 'symbol' ? 0.35 : 0.08)))
    .force('charge', d3.forceManyBody().strength((d: any) => {
      if (d._type === 'symbol') return -40;
      const deg = degreeMap.get(d.id) || 0;
      return -(100 + deg * 28);
    }))
    .force('center', isFirstRender ? d3.forceCenter(w/2, h/2) : null)
    .force('gx', d3.forceX(w/2).strength(0.015))
    .force('gy', d3.forceY(h/2).strength(0.015))
    .force('collision', d3.forceCollide((d: any) => d._type === 'symbol' ? 20 : (d._expanded ? 14 : 48)))
    .force('grouping', forceGroup)
    .alpha(isFirstRender ? 1 : 0.3)
    .restart();

  root.selectAll('.hull-layer').remove();
  const hullLayer = root.insert('g', ':first-child').attr('class', 'hull-layer');
  const hullPaths = new Map<string, any>();
  for (const pid of groupSymbols.keys()) {
    hullPaths.set(pid, hullLayer.append('path')
      .style('fill', '#8b949e').style('fill-opacity', '0.07')
      .style('stroke', '#8b949e').style('stroke-opacity', '0.35')
      .style('stroke-width', '1.5').style('pointer-events', 'none'));
  }

  root.selectAll('.link, .link-label-g').remove();
  linkSel = root.insert('g', '.nodes').attr('class', 'links')
    .selectAll('line').data(allLinks).join('line')
    .attr('class', (d: any) => {
      const st = d.status && d.status !== 'unchanged' ? ' ' + d.status : '';
      return 'link' + st;
    })
    .attr('marker-end', (d: any) => {
      const s = d.status && d.status !== 'unchanged' ? d.status : null;
      return s ? 'url(#arrow-' + s + ')' : 'url(#arrow)';
    })
    .on('mouseenter', (e: any, d: any) => showLinkTooltip(e, d))
    .on('mouseleave', () => tooltip.classList.remove('visible'));

  root.selectAll('.node, .symbol-node').remove();
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

  nodeSel.filter((d: any) => d._type === 'file' && d._expanded).append('circle')
    .attr('r', 4).attr('fill', (d: any) => nodeColor(d)).attr('fill-opacity', 0.5).attr('stroke', 'none');

  nodeSel.filter((d: any) => d._type === 'file' && !d._expanded).append('circle')
    .attr('r', 10).attr('fill', (d: any) => nodeColor(d))
    .attr('stroke', 'rgba(255,255,255,0.15)').attr('stroke-width', 1.5);

  nodeSel.filter((d: any) => d._type === 'symbol').each(function (this: any, d: any) {
    const g = d3.select(this);
    const col = symColor(d);
    const sh = symShape(d);
    if (sh === 'triangle') {
      g.append('polygon').attr('points', '0,-8 7,5 -7,5')
        .attr('fill', col).attr('stroke', col).attr('stroke-opacity', 0.5).attr('stroke-width', 1).attr('opacity', 0.85);
    } else if (sh === 'square') {
      g.append('rect').attr('x', -6).attr('y', -6).attr('width', 12).attr('height', 12).attr('rx', 1)
        .attr('fill', col).attr('stroke', col).attr('stroke-opacity', 0.5).attr('stroke-width', 1).attr('opacity', 0.85);
    } else {
      g.append('circle').attr('r', 7)
        .attr('fill', col).attr('stroke', col).attr('stroke-opacity', 0.5).attr('stroke-width', 1).attr('opacity', 0.85);
    }
  });

  nodeSel.filter((d: any) => d._type === 'file').append('text').attr('class', 'label')
    .attr('x', (d: any) => d._expanded ? 0 : 14)
    .attr('y', (d: any) => d._expanded ? -14 : 0)
    .attr('text-anchor', (d: any) => d._expanded ? 'middle' : 'start')
    .attr('fill', (d: any) => d._expanded ? '#7d8590' : '#e6edf3')
    .text((d: any) => shortLabel(d.label || d.id));

  nodeSel.filter((d: any) => d._type === 'symbol').append('text')
    .attr('class', 'label').attr('x', 10).attr('y', 0)
    .text((d: any) => shortLabel(d.label || d.id));


  simulation.on('tick', () => {
    linkSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
            .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
    nodeSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    groupSymbols.forEach((syms, pid) => {
      const p = nodeById.get(pid);
      if (p) hullPaths.get(pid).attr('d', hullPath([[p.x, p.y]].concat(syms.map(s => [s.x, s.y])), 22));
    });
  });
}

function symShape(d: any): string {
  const k = d.kind ?? '';
  if (k === 'function' || k === 'method') return 'triangle';
  if (k === 'class' || k === 'interface' || k === 'type' || k === 'enum') return 'square';
  return 'circle'; // property, const, field, unknown
}

function changedSymbols(d: GraphNode): GraphSymbol[] {
  return (d.symbols ?? []).filter(s => s.status && s.status !== 'unchanged');
}

// A file node is expandable if it has changed symbols (signature or body diff).
function expandable(d: any): boolean {
  return d._type === 'file' && changedSymbols(d).length > 0;
}

function handleDblClick(d: any) {
  if (!expandable(d)) return;
  if (expandedNodes.has(d.id)) expandedNodes.delete(d.id); else expandedNodes.add(d.id);
  render();
}

const tooltip = document.getElementById('tooltip')!;
function showTooltip(event: MouseEvent, d: any) {
  const s = nodeStatus(d);
  const col = s ? STATUS_COLOR[s] : '';
  const badge = s ? ' <span style="color:' + col + ';font-weight:700">[' + s + ']</span>' : '';
  const sig = d.signature ? '<br><code style="font-size:10px;color:#adbac7">' + d.signature.replace(/</g,'&lt;').slice(0,120) + '</code>' : '';
  const changed = changedSymbols(d);
  const hint = changed.length ? '<br>double-click to ' + (expandedNodes.has(d.id) ? 'collapse' : 'expand (' + changed.length + ' changed)') : '';
  tooltip.innerHTML = '<strong>' + shortLabel(d.label || d.id) + '</strong><span class="meta">' +
    (d._type === 'symbol' ? (d.kind || 'symbol') : (d.path || d.id)) + badge + sig + hint + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}
function moveTooltip(e: MouseEvent) {
  const wrap = document.getElementById('canvas-wrap')!.getBoundingClientRect();
  let x = e.clientX - wrap.left + 12, y = e.clientY - wrap.top + 12;
  if (x + 310 > wrap.width) x -= 320;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}

const LINK_TYPE_LABEL: Record<string, string> = { import: 'import', call: 'call', sibling: 'sibling (same component)' };
function showLinkTooltip(event: MouseEvent, d: any) {
  const s = d.status && d.status !== 'unchanged' ? d.status : null;
  const col = s ? STATUS_COLOR[s] : '';
  const badge = s ? ' <span style="color:' + col + ';font-weight:700">[' + s + ']</span>' : '';
  const srcLabel = shortLabel(d.source?.label ?? d.source?.id ?? d.source);
  const tgtLabel = shortLabel(d.target?.label ?? d.target?.id ?? d.target);
  tooltip.innerHTML = '<strong>' + (LINK_TYPE_LABEL[d._linkType] ?? d._linkType) + '</strong><span class="meta">' +
    srcLabel + ' &rarr; ' + tgtLabel + badge + '</span>';
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
document.getElementById('btn-reset-expand')!.addEventListener('click', () => { expandedNodes.clear(); render(); });

const evtSource = new EventSource('/events');
evtSource.onmessage = (e: MessageEvent) => {
  try { const d = JSON.parse(e.data); if (d.type === 'graph') { graphData = d.payload; render(); setTimeout(fitView, 600); } } catch (err) {}
};

render();
if (graphData.nodes && graphData.nodes.length > 0) setTimeout(fitView, 600);
