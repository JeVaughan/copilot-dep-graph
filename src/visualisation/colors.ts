// colors.ts - single source of truth for every status colour and opacity —
// "unchanged" is a real status here, not a separate fallback constant.
import { depthScale } from "./sizing.js";

declare const d3: any;

export const STATUS_COLOR: Record<string, string> = { added: '#56d364', modified: '#e3b341', removed: '#f85149', unchanged: '#8b949e' };
export const STATUS_OPACITY: Record<string, number> = { added: 0.35, modified: 0.35, removed: 0.30, unchanged: 0.45 };

export function nodeStatus(d: any): string | null { return d.status ?? null; }
export function nodeColor(d: any): string { return STATUS_COLOR[d.status ?? 'unchanged']; }
export function symColor(d: any): string { return STATUS_COLOR[d.status ?? 'unchanged']; }
export function shortLabel(id: string): string { return (id ?? '').split('/').pop()!; }

// Lightens toward white with depth, reusing the same depthScale() everything else
// scales by (as 1 - depthScale) so a hull lightens in the same proportion its
// padding shrinks.
export const HULL_BASE_COLOR = '#1d4e89';
export function hullColor(depth: number): string {
  return d3.interpolateRgb(HULL_BASE_COLOR, '#ffffff')(1 - depthScale(depth));
}
