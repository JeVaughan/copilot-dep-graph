// render.ts - split into four phases: buildGraph, runSimulation, draw, wireTick.
// Nodes and links are built together in one buildGraph, not two separate phases —
// this is the shape a future per-language graph builder (one builder per parser,
// merged afterward) would also need: a graph's nodes and edges are produced
// together, not as independently-built, independently-mergeable pieces.
import { nextExpandLevel } from "../aggregate.mjs";
import { type VizState } from "./state.js";
import { svg, root, defs } from "./dom.js";
import { STATUS_COLOR, STATUS_OPACITY, nodeColor, symColor, shortLabel, hullColor } from "./colors.js";
import {
  depthScale, COLLISION_BASE_RADIUS, HULL_BASE_PAD, LINK_STRENGTH_PER_COUNT, LINK_MID_FADE,
  linkWidth, fadeStopOffsets, hullPath, symShape,
} from "./sizing.js";
import { symbolCounts, hiddenCount, expandable, handleDblClick } from "./expand-state.js";
import { focusNode, focusContainerArea, focusEdge, clearFocus } from "./hover.js";
import { showTooltip, showLinkTooltip } from "./tooltip.js";
import { tooltip } from "./dom.js";
import { buildGraph, type RenderGraph } from "./graph-builder.js";

declare const d3: any;

(['added', 'modified', 'removed'] as const).forEach(status => {
  const el = document.getElementById('legend-' + status);
  if (el) el.style.color = STATUS_COLOR[status];
});

function runSimulation(state: VizState, graph: RenderGraph) {
  const { allNodes, allLinks, nodeById, isFirstRender, degreeMap } = graph;

  function forceGroup(alpha: number) {
    const R_ATTRACT = 65, K_ATTRACT = 0.25;
    const GROUP_PAD = 35;

    // The leash is a pure distance, like the collision radius, so it uses _scale²
    // (not _scale) to shrink in step with the symbol's felt (area) size rather than
    // lagging behind its linear glyph radius.
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

    for (const [parentId, syms] of state.groupSymbols) {
      const parent = nodeById.get(parentId); if (!parent) continue;
      const memberIds = new Set([parentId, ...syms.map(s => s.id)]);

      let cx = parent.x, cy = parent.y;
      for (const s of syms) { cx += s.x; cy += s.y; }
      cx /= (1 + syms.length); cy /= (1 + syms.length);

      let maxR = Math.sqrt((parent.x-cx)**2 + (parent.y-cy)**2);
      for (const s of syms) {
        const r = Math.sqrt((s.x-cx)**2 + (s.y-cy)**2);
        if (r > maxR) maxR = r;
      }
      const groupR = maxR + GROUP_PAD;

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

  const w = svg.node().clientWidth || 800, h = svg.node().clientHeight || 600;

  state.simulation = d3.forceSimulation(allNodes)
    .force('link', d3.forceLink(allLinks).id((d: any) => d.id)
      .distance((d: any) => d.type === 'sibling' ? 30 : d.type === 'import' ? 55 : 70)
      // Weighted by how many raw edges this rendered link represents, not by edge
      // type — a link standing in for 5 collapsed relationships pulls 5x harder than
      // one standing in for a single relationship.
      .strength((d: any) => LINK_STRENGTH_PER_COUNT * (d.count ?? 1)))
    .force('charge', d3.forceManyBody().strength((d: any) => {
      if (d._type === 'symbol') return -40;
      const deg = degreeMap.get(d.id) || 0;
      return -(100 + deg * 28);
    }))
    .force('center', isFirstRender ? d3.forceCenter(w/2, h/2) : null)
    .force('gx', d3.forceX(w/2).strength(0.015))
    .force('gy', d3.forceY(h/2).strength(0.015))
    // _scale², not _scale: a glyph's felt "size" is its area (radius²), so a
    // pure-distance quantity like collision radius has to square the linear scale
    // factor to shrink in step with how much smaller the glyph actually looks.
    .force('collision', d3.forceCollide((d: any) => COLLISION_BASE_RADIUS * d._scale * d._scale))
    .force('grouping', forceGroup)
    .alpha(isFirstRender ? 1 : 0.3)
    .restart();
}

function draw(state: VizState, graph: RenderGraph) {
  const { allNodes, allLinks, containerDepth, borderColor } = graph;

  root.selectAll('.hull-layer').remove();
  const hullLayer = root.insert('g', ':first-child').attr('class', 'hull-layer');
  state.hullPaths = new Map<string, any>();
  for (const pid of state.groupSymbols.keys()) {
    const col = hullColor(containerDepth.get(pid) ?? 0);
    // pointer-events is left at its default (not 'none'), so hovering the fuzzy area
    // itself — not just the node glyph — triggers focusContainerArea.
    state.hullPaths.set(pid, hullLayer.append('path')
      .style('fill', col).style('fill-opacity', '0.07')
      .style('stroke', col).style('stroke-opacity', '0.35')
      .style('stroke-width', '1.5')
      .on('mouseenter', () => focusContainerArea(pid, state))
      .on('mouseleave', () => clearFocus(state)));
  }

  // Rebuilt in the same allLinks order as the lines below, so each line's stroke can
  // reference its gradient by index (url(#link-grad-i)).
  defs.selectAll('.link-gradient').remove();
  state.gradientSel = defs.selectAll('.link-gradient').data(allLinks).join('linearGradient')
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
  state.linkSel = root.append('g').attr('class', 'links')
    .selectAll('line').data(allLinks).join('line')
    .attr('class', (d: any) => {
      const st = d.status && d.status !== 'unchanged' ? ' ' + d.status : '';
      return 'link' + st;
    })
    .attr('stroke', (_d: any, i: number) => 'url(#link-grad-' + i + ')')
    .attr('stroke-width', (d: any) => linkWidth(d.count ?? 1))
    .on('mouseenter', (e: any, d: any) => { showLinkTooltip(e, d); focusEdge(d, state); })
    .on('mouseleave', () => { tooltip.classList.remove('visible'); clearFocus(state); });

  root.selectAll('.nodes').remove();
  state.nodeSel = root.append('g').attr('class', 'nodes')
    .selectAll('g').data(allNodes).join('g')
    .attr('class', (d: any) => (d._type === 'symbol' ? 'symbol-node' : 'node') + (expandable(d, state) ? ' expandable' : ''))
    .call(d3.drag()
      .on('start', (e: any, d: any) => { if (!e.active) state.simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e: any, d: any) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e: any, d: any) => { if (!e.active) state.simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('dblclick', (e: any, d: any) => { e.stopPropagation(); handleDblClick(d, state); })
    .on('mouseenter', (e: any, d: any) => { showTooltip(e, d, state); focusNode(d.id, state); })
    .on('mouseleave', () => { tooltip.classList.remove('visible'); clearFocus(state); });

  state.nodeSel.filter((d: any) => d._type === 'file').append('circle')
    .attr('r', 10).attr('fill', (d: any) => nodeColor(d))
    .attr('stroke', (d: any) => borderColor(d.id)).attr('stroke-width', 2);

  state.nodeSel.filter((d: any) => d._type === 'symbol').each(function (this: any, d: any) {
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

  // Inside the container's own <g> (not the labels group) so it moves with the node
  // without its own tick tracking, and appended after the shape above so it isn't
  // covered by it.
  state.nodeSel.filter((d: any) => expandable(d, state)).each(function (this: any, d: any) {
    const level = state.expandLevel.get(d.id) ?? 0;
    const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(d.id, state);
    const hidden = hiddenCount(d.id, state);
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
  state.labelSel = root.append('g').attr('class', 'labels')
    .selectAll('text').data(allNodes).join('text')
    .attr('class', (d: any) => 'label ' + (d._type === 'symbol' ? 'symbol' : 'file'))
    .attr('x', 0).attr('y', -14).attr('text-anchor', 'middle')
    .text((d: any) => d.label ?? shortLabel(d.id));
}

function wireTick(state: VizState, graph: RenderGraph) {
  const { nodeById, containerDepth } = graph;

  state.simulation.on('tick', () => {
    state.linkSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
            .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
    // The fade-in/out offsets encode a fixed pixel distance from each end
    // (LINK_FADE_DISTANCE), and a link's on-screen length keeps changing as the
    // simulation moves its endpoints, so both need recomputing every tick too.
    state.gradientSel.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
               .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y)
               .each(function (this: any, d: any) {
                 const [f1, f2] = fadeStopOffsets(d);
                 const g = d3.select(this);
                 g.select('.stop-fade-in').attr('offset', (f1 * 100) + '%');
                 g.select('.stop-fade-out').attr('offset', (f2 * 100) + '%');
               });
    state.nodeSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    state.labelSel.attr('transform', (d: any) => 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')');
    state.groupSymbols.forEach((syms, pid) => {
      const p = nodeById.get(pid);
      if (!p) return;
      // Squared for the same reason the collision radius and parent-leash are: pad is
      // a pure distance, so it should shrink with the container's felt (area) size.
      const containerScale = depthScale(containerDepth.get(pid) ?? 0);
      const pad = HULL_BASE_PAD * containerScale * containerScale;
      state.hullPaths.get(pid).attr('d', hullPath([[p.x, p.y]].concat(syms.map(s => [s.x, s.y])), pad));
    });
  });
}

export function render(state: VizState) {
  const { nodes: rawNodes, edges: rawEdges } = state.graphData;
  document.getElementById('graph-title')!.textContent = state.graphData.title ?? 'Dependency Graph';
  if (!rawNodes || !rawNodes.length) {
    document.getElementById('empty')!.classList.add('show');
    document.getElementById('empty-msg')!.textContent = state.graphData.error ?? 'No graph loaded.';
    document.getElementById('stats')!.textContent = '';
    return;
  }
  document.getElementById('empty')!.classList.remove('show');

  const graph = buildGraph(state);

  document.getElementById('stats')!.textContent =
    `Nodes ${graph.allNodes.length}/${rawNodes.length} · Edges ${graph.allLinks.length}/${rawEdges.length}`;

  runSimulation(state, graph);
  draw(state, graph);
  wireTick(state, graph);
}
