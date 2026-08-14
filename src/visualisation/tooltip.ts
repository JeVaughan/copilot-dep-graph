import { tooltip } from "./dom.js";
import { STATUS_COLOR, nodeStatus, shortLabel } from "./colors.js";
import { expandable, expandHint } from "./expand-state.js";
import type { VizState } from "./state.js";

export function showTooltip(event: MouseEvent, d: any, state: VizState) {
  const s = nodeStatus(d);
  const col = s ? STATUS_COLOR[s] : '';
  const badge = s ? ' <span style="color:' + col + ';font-weight:700">[' + s + ']</span>' : '';
  const hintText = expandable(d, state) ? expandHint(d.id, state) : '';
  const hint = hintText ? '<br>' + hintText : '';
  tooltip.innerHTML = '<strong>' + (d.label ?? shortLabel(d.id)) + '</strong><span class="meta">' +
    (d._type === 'symbol' ? (d.type || 'symbol') : 'file') + badge + hint + '</span>';
  tooltip.classList.add('visible');
  moveTooltip(event);
}

export function moveTooltip(e: MouseEvent) {
  const wrap = document.getElementById('canvas-wrap')!.getBoundingClientRect();
  let x = e.clientX - wrap.left + 12, y = e.clientY - wrap.top + 12;
  if (x + 310 > wrap.width) x -= 320;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}

export function showLinkTooltip(event: MouseEvent, d: any) {
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
