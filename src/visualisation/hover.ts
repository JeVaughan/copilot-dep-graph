// hover.ts - the three hover-focus modes (node glyph, container area, edge) and
// the dimming mechanics they share.
import { STATUS_COLOR, STATUS_OPACITY } from "./colors.js";
import type { VizState } from "./state.js";

export const HOVER_DIM_OPACITY = 0.12;

// Every id "related" to a hovered node's own glyph: itself, its neighbours (via a
// rendered edge), its ancestor containers, and its own members if it's a
// container itself. Applies uniformly regardless of node kind.
function relatedNodeIds(hoveredId: string, state: VizState): Set<string> {
  const related = new Set<string>([hoveredId]);
  for (const n of (state.neighborsByNode.get(hoveredId) ?? [])) related.add(n);
  for (let cur = state.nodeMeta.get(hoveredId); cur?.parent; cur = state.nodeMeta.get(cur.parent)) related.add(cur.parent);
  for (const desc of (state.groupSymbols.get(hoveredId) ?? [])) related.add(desc.id);
  return related;
}

// A hovered id's own ancestor chain, plus itself — the containers that actually
// contain it. Used two ways: (1) as the set of hulls that stay bright no matter which
// of the above two hover modes triggered — a container should only stay bright
// because the hovered thing lives inside it, never because it merely contains some
// other related node; (2) as the *entire* related set when hovering a container's
// AREA (its hull) rather than its glyph — see focusContainerArea.
function ancestorIds(hoveredId: string, state: VizState): Set<string> {
  const ancestors = new Set<string>([hoveredId]);
  for (let cur = state.nodeMeta.get(hoveredId); cur?.parent; cur = state.nodeMeta.get(cur.parent)) ancestors.add(cur.parent);
  return ancestors;
}

// Also flattens each link's stroke to a solid colour for the duration of any
// hover (gradient is restored by clearFocus()) — the gradient's varying opacity
// would fight with the dim/bright toggle here.
function applyDimming(state: VizState, nodeRelated: Set<string>, hullRelated: Set<string>, edgeIsBright: (d: any) => boolean) {
  state.nodeSel.style('opacity', (d: any) => nodeRelated.has(d.id) ? null : HOVER_DIM_OPACITY);
  state.labelSel.style('opacity', (d: any) => nodeRelated.has(d.id) ? null : HOVER_DIM_OPACITY);
  state.linkSel
    .attr('stroke', (d: any) => STATUS_COLOR[d.status ?? 'unchanged'])
    .attr('stroke-opacity', (d: any) => STATUS_OPACITY[d.status ?? 'unchanged'])
    .style('opacity', (d: any) => edgeIsBright(d) ? null : HOVER_DIM_OPACITY);
  state.hullPaths.forEach((path: any, containerId: string) => {
    path.style('opacity', hullRelated.has(containerId) ? null : HOVER_DIM_OPACITY);
  });
}

// The generous hover rule: an edge stays bright if it touches the hovered node
// directly, or one of its members when the hovered node is a container.
export function focusNode(hoveredId: string, state: VizState) {
  const subtree = new Set<string>([hoveredId, ...(state.groupSymbols.get(hoveredId) ?? []).map((n: any) => n.id)]);
  applyDimming(state, relatedNodeIds(hoveredId, state), ancestorIds(hoveredId, state),
    (d: any) => subtree.has(d.source.id) || subtree.has(d.target.id));
}

// The strict rule: hovering a container's hull only lights up the container
// itself and its ancestor chain — no edges, no members, no neighbours.
export function focusContainerArea(containerId: string, state: VizState) {
  const ancestorsOrSelf = ancestorIds(containerId, state);
  applyDimming(state, ancestorsOrSelf, ancestorsOrSelf, () => false);
}

// Identity (===) is enough to pick out "this exact edge" since d is the same
// object reference bound to linkSel throughout the current render.
export function focusEdge(hovered: any, state: VizState) {
  applyDimming(state, new Set<string>([hovered.source.id, hovered.target.id]), new Set<string>(), (d: any) => d === hovered);
}

export function clearFocus(state: VizState) {
  state.nodeSel.style('opacity', null);
  state.labelSel.style('opacity', null);
  state.linkSel.style('opacity', null).attr('stroke', (_d: any, i: number) => 'url(#link-grad-' + i + ')').attr('stroke-opacity', null);
  state.hullPaths.forEach((path: any) => path.style('opacity', null));
}
