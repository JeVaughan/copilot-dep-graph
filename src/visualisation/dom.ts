// dom.ts - top-level DOM/D3 handles, created once since there's exactly one graph
// canvas per page. Safe to export as plain consts (unlike state.ts's fields) because
// they're never reassigned — only mutated via D3 method calls.
declare const d3: any;

export const svg = d3.select('#svg');
export const root = d3.select('#root');
export const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', (e: any) => root.attr('transform', e.transform));
svg.call(zoom).on('dblclick.zoom', null);
export const defs = svg.append('defs');
export const tooltip = document.getElementById('tooltip')!;
