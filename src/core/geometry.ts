// Pure geometry helpers. All coordinates are floor-image pixels, y-down.
import type { Vec2 } from "./model";

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function projectPointOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { point: { x: a.x, y: a.y }, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** Intersection of the forward ray (origin + dir*t, t >= 0) with segment a—b.
 *  dir need not be unit length; rayT is in units of |dir|. */
export function raySegmentIntersection(
  origin: Vec2,
  dir: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; rayT: number; segT: number } | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const D = dir.x * sy - dir.y * sx;
  if (Math.abs(D) < 1e-12) return null; // parallel or degenerate
  const qx = a.x - origin.x;
  const qy = a.y - origin.y;
  const rayT = (qx * sy - qy * sx) / D;
  const segT = (qx * dir.y - qy * dir.x) / D;
  if (rayT < 0 || segT < 0 || segT > 1) return null;
  return {
    point: { x: origin.x + dir.x * rayT, y: origin.y + dir.y * rayT },
    rayT,
    segT,
  };
}

/** Proper crossing of segments a—b and c—d: both parameters strictly interior
 *  (shared endpoints and end-touches don't count). Returns t on a—b, u on c—d. */
export function segSegIntersection(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const D = rx * sy - ry * sx;
  if (Math.abs(D) < 1e-12) return null; // parallel or degenerate
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / D;
  const u = (qx * ry - qy * rx) / D;
  const EPS = 1e-6;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { point: { x: a.x + rx * t, y: a.y + ry * t }, t, u };
}

/** Nearest multiple of 45° to the direction of v. Returns degrees in [0, 315] and a unit vector. */
export function nearest45(v: Vec2): { angleDeg: number; dir: Vec2 } {
  const ang = Math.atan2(v.y, v.x);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  let deg = Math.round((snapped * 180) / Math.PI);
  deg = ((deg % 360) + 360) % 360;
  return { angleDeg: deg, dir: { x: Math.cos(snapped), y: Math.sin(snapped) } };
}

/** Absolute angle between two direction vectors, in degrees (0..180). */
export function angleDeltaDeg(a: Vec2, b: Vec2): number {
  const a1 = Math.atan2(a.y, a.x);
  const a2 = Math.atan2(b.y, b.x);
  let d = (Math.abs(a1 - a2) * 180) / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

/** Shoelace signed area. With our face-tracing convention (y-down, rotate-after-twin),
 *  bounded/interior faces come out positive. */
export function polygonSignedArea(pts: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

export function polygonCentroid(pts: Vec2[]): Vec2 {
  const A = polygonSignedArea(pts);
  if (Math.abs(A) < 1e-9) {
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p.x;
      my += p.y;
    }
    return { x: mx / Math.max(1, pts.length), y: my / Math.max(1, pts.length) };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

/** Even-odd ray-casting point-in-polygon test. */
export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
