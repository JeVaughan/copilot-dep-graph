// graph-client.ts - browser entry point for the D3 force graph renderer. Served
// (after compilation + placeholder substitution) as /graph-client.js by viewer.mts.
// Loaded as a real ES module (<script type="module">), importing the rest of the
// renderer from ./visualisation/ — including aggregate.mts's collapsing logic,
// shared directly with the Node-side tests rather than duplicated.
//
// Kept deliberately thin: page-level bootstrapping only (wiring the initial data in,
// the toolbar buttons, and the SSE live-update feed). Everything about how the graph
// is actually drawn lives under ./visualisation/.
import type { GraphData } from "./types.mjs";
import { createVizState } from "./visualisation/state.js";
import { render } from "./visualisation/render.js";
import { svg, root, zoom, tooltip } from "./visualisation/dom.js";
import { moveTooltip } from "./visualisation/tooltip.js";

declare const d3: any;
// Substituted server-side (see renderClientJs in viewer.mts) before this
// script reaches the browser.
declare const __GRAPH_DATA__: GraphData;

// The one VizState instance for this page, constructed here and passed explicitly
// into render() and everything render() calls — nothing in ./visualisation/ reaches
// for a shared global.
const state = createVizState();
state.graphData = __GRAPH_DATA__;

svg.node().addEventListener('mousemove', (e: MouseEvent) => { if (tooltip.classList.contains('visible')) moveTooltip(e); });

function fitView() {
  const b = root.node().getBBox(); if (!b.width || !b.height) return;
  const w = svg.node().clientWidth || 800, h = svg.node().clientHeight || 600;
  const scale = Math.min(0.9, 0.9 / Math.max(b.width/w, b.height/h));
  const tx = w/2 - scale*(b.x + b.width/2), ty = h/2 - scale*(b.y + b.height/2);
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}
document.getElementById('btn-fit')!.addEventListener('click', fitView);
document.getElementById('btn-reset-expand')!.addEventListener('click', () => { state.expandLevel.clear(); render(state); });

const evtSource = new EventSource('/events');
evtSource.onmessage = (e: MessageEvent) => {
  try {
    const d = JSON.parse(e.data);
    if (d.type === 'graph') { state.graphData = d.payload; render(state); setTimeout(fitView, 600); }
  } catch (err) {}
};

render(state);
if (state.graphData.nodes && state.graphData.nodes.length > 0) setTimeout(fitView, 600);
