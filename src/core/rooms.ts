// Room detection: bounded faces of the planar wall graph via half-edge tracing.
//
// For each undirected edge we create two directed half-edges. Outgoing half-edges
// at each node are sorted by angle; the successor of half-edge (u→v) is found at v
// by locating the twin (v→u) in v's sorted list and taking the PREVIOUS entry
// (cyclic). With y-down coordinates this traces bounded faces with POSITIVE
// shoelace area; the unbounded outer face of each component comes out negative
// and is discarded. (Taking the NEXT entry instead turns the wrong way at
// degree-3+ junctions and traces the merged outer hull — see rooms.test.ts.)
//
// Known v1 limit: a free-standing loop inside a room (a pillar) is a separate
// component — its hole is not subtracted from the surrounding room's polygon.
import type { Graph, NodeId, Vec2 } from "./model";
import { pointInPolygon, polygonSignedArea } from "./geometry";

export interface Face {
  loop: NodeId[];
  area: number; // signed: bounded faces positive, each component's outer face negative
}

/** Every face of the graph, signed. Bounded (interior) faces are positive;
 *  the unbounded outer face of each closed component is negative. */
function traceAllFaces(g: Graph): Face[] {
  const out = new Map<NodeId, NodeId[]>();
  for (const e of Object.values(g.edges)) {
    if (!g.nodes[e.a] || !g.nodes[e.b]) continue;
    if (!out.has(e.a)) out.set(e.a, []);
    if (!out.has(e.b)) out.set(e.b, []);
    out.get(e.a)!.push(e.b);
    out.get(e.b)!.push(e.a);
  }
  for (const [id, nbrs] of out) {
    const n = g.nodes[id];
    nbrs.sort(
      (p, q) =>
        Math.atan2(g.nodes[p].y - n.y, g.nodes[p].x - n.x) -
        Math.atan2(g.nodes[q].y - n.y, g.nodes[q].x - n.x),
    );
  }

  const visited = new Set<string>();
  const faces: Face[] = [];
  const LIMIT = 100_000;

  for (const e of Object.values(g.edges)) {
    if (!g.nodes[e.a] || !g.nodes[e.b]) continue;
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as const) {
      if (visited.has(`${from}>${to}`)) continue;
      const loop: NodeId[] = [];
      let cf = from;
      let ct = to;
      let guard = 0;
      while (guard++ < LIMIT) {
        visited.add(`${cf}>${ct}`);
        loop.push(cf);
        const nbrs = out.get(ct)!;
        const idx = nbrs.indexOf(cf);
        const nxt = nbrs[(idx - 1 + nbrs.length) % nbrs.length];
        cf = ct;
        ct = nxt;
        if (cf === from && ct === to) break;
      }
      if (guard >= LIMIT || loop.length < 3) continue;
      const pts = loop.map((id) => g.nodes[id]);
      const area = polygonSignedArea(pts);
      if (Math.abs(area) > 1e-6) faces.push({ loop, area });
    }
  }
  return faces;
}

/** Bounded faces only — the candidate rooms. */
export function traceFaces(g: Graph): Face[] {
  return traceAllFaces(g).filter((f) => f.area > 0);
}

/** The building footprint: the outer boundary of the largest closed component,
 *  reversed into the same positive orientation as room loops. Null when no
 *  component forms a closed cycle (open perimeter). */
export function outerBoundary(g: Graph): NodeId[] | null {
  let best: Face | null = null;
  for (const f of traceAllFaces(g)) {
    if (f.area < 0 && (!best || f.area < best.area)) best = f;
  }
  return best ? [...best.loop].reverse() : null;
}

/** Smallest bounded face containing the point (handles nesting), or null. */
export function faceAtPoint(g: Graph, faces: Face[], p: Vec2): Face | null {
  let best: Face | null = null;
  for (const f of faces) {
    const pts = f.loop.map((id) => g.nodes[id]);
    if (pointInPolygon(p, pts) && (!best || f.area < best.area)) best = f;
  }
  return best;
}

/** Rotation- and direction-invariant identity for a loop, for duplicate detection. */
export function canonicalLoopKey(loop: NodeId[]): string {
  if (!loop.length) return "";
  const n = loop.length;
  let best: string | null = null;
  for (const seq of [loop, [...loop].reverse()]) {
    for (let s = 0; s < n; s++) {
      const rot = seq
        .slice(s)
        .concat(seq.slice(0, s))
        .join(",");
      if (best === null || rot < best) best = rot;
    }
  }
  return best!;
}
