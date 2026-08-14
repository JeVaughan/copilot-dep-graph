declare const d3: any;

// Each level of nesting shrinks a glyph/badge by this fraction relative to its
// parent, down to a floor so deep nesting never becomes unreadable.
export const CHILD_SCALE_STEP = 0.78;
export const CHILD_SCALE_FLOOR = 0.5;
export function depthScale(depth: number): number {
  return Math.max(CHILD_SCALE_FLOOR, Math.pow(CHILD_SCALE_STEP, depth));
}

// A file's collision radius before any depth scaling (a file is depth 0, so this
// is also its actual radius). Every node's radius is this base times
// depthScale(depth)² — squared because a glyph's felt "size" is its area
// (radius²), so a pure-distance quantity like collision radius must square the
// scale to shrink in step with it.
export const COLLISION_BASE_RADIUS = 48;

// A container's hull padding is HULL_BASE_PAD * depthScale(depth)² — squared for
// the same reason collision radius is.
export const HULL_BASE_PAD = 36;

// Edge stroke-width as a function of count — rises but asymptotes rather than
// growing without bound, so one heavily-aggregated link can't visually swamp the
// graph. LINK_WIDTH_LIMIT is the width approached as count → ∞; LINK_WIDTH_HALF_COUNT
// is the count at which it's already at half that limit (a standard saturating,
// Michaelis-Menten-shaped curve).
export const LINK_WIDTH_LIMIT = COLLISION_BASE_RADIUS / 3;
export const LINK_WIDTH_HALF_COUNT = 11;
export function linkWidth(count: number): number {
  return LINK_WIDTH_LIMIT * count / (count + LINK_WIDTH_HALF_COUNT);
}

export const LINK_STRENGTH_PER_COUNT = 0.08;

// A link's midpoint opacity as a fraction of its peak (end) opacity — edges fade
// toward a faded middle instead of a flat stroke-opacity, so they read as anchored
// at their nodes without cluttering the space between.
export const LINK_MID_FADE = 0.2;
// The fade ramp near each end is a fixed distance in px, not a fraction of the link's
// own length — otherwise a long edge fades gently over hundreds of px while a short
// one barely fades at all. Capped at 50% of the link's length so short links still
// meet cleanly in the middle rather than overshooting past each other.
export const LINK_FADE_DISTANCE = 40;
export function fadeStopOffsets(d: any): [number, number] {
  const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const frac = Math.min(0.5, LINK_FADE_DISTANCE / len);
  return [frac, 1 - frac];
}

export function hullPath(pts: number[][], pad: number): string {
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
    const semiMajor = Math.max(1.2 * pad, dist / 2 + pad);
    const semiMinor = 1.2 * pad;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const N = 24;
    const ellipse: number[][] = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI;
      const ex = semiMajor * Math.cos(t), ey = semiMinor * Math.sin(t);
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

export function symShape(d: any): string {
  const k = d.type ?? '';
  if (k === 'function' || k === 'method') return 'triangle';
  if (k === 'class' || k === 'interface' || k === 'type' || k === 'enum') return 'square';
  return 'circle'; // property, const, field, unknown
}
