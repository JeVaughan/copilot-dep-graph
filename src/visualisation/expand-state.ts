import { visibleChildren, nextExpandLevel } from "../aggregate.mjs";
import { type VizState, hasChangedEdge } from "./state.js";
import { render } from "./render.js";

export function symbolCounts(containerId: string, state: VizState): { ownChanged: number; edgeChanged: number; fullyUnchanged: number; total: number } {
  const children = state.childrenByParent.get(containerId) ?? [];
  let ownChanged = 0, edgeChanged = 0, fullyUnchanged = 0;
  for (const c of children) {
    if (c.status && c.status !== 'unchanged') ownChanged++;
    else if (hasChangedEdge(c.id, state)) edgeChanged++;
    else fullyUnchanged++;
  }
  return { ownChanged, edgeChanged, fullyUnchanged, total: children.length };
}

export function hiddenCount(containerId: string, state: VizState): number {
  const { total } = symbolCounts(containerId, state);
  const level = state.expandLevel.get(containerId) ?? 0;
  const children = state.childrenByParent.get(containerId) ?? [];
  return total - visibleChildren(children, level, (id: string) => hasChangedEdge(id, state)).length;
}

// Expandable if it has any children at all, changed or not.
export function expandable(d: any, state: VizState): boolean {
  return symbolCounts(d.id, state).total > 0;
}

export function handleDblClick(d: any, state: VizState) {
  if (!expandable(d, state)) return;
  const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(d.id, state);
  const next = nextExpandLevel(state.expandLevel.get(d.id) ?? 0, ownChanged, edgeChanged, fullyUnchanged);
  if (next === 0) state.expandLevel.delete(d.id); else state.expandLevel.set(d.id, next);
  render(state);
}

export function expandHint(containerId: string, state: VizState): string {
  const { ownChanged, edgeChanged, fullyUnchanged } = symbolCounts(containerId, state);
  const current = state.expandLevel.get(containerId) ?? 0;
  const next = nextExpandLevel(current, ownChanged, edgeChanged, fullyUnchanged);
  if (next === current) return '';
  if (next === 0) return 'double-click to collapse';
  if (next === 1) return 'double-click to expand (' + ownChanged + ' changed)';
  if (next === 2) return 'double-click to show ' + edgeChanged + ' with a changed edge';
  return 'double-click to show ' + fullyUnchanged + ' unchanged';
}
