// The snapping engine. Pure function of its arguments — no store access — so it is
// easy to unit test. All tolerances are given in SCREEN pixels and divided by zoom once.
import type { Graph, GraphNode, NodeId, Poi, Vec2 } from "./model";
import {
  angleDeltaDeg,
  dist,
  nearest45,
  projectPointOnSegment,
  raySegmentIntersection,
} from "./geometry";

export const SNAP = {
  node: 12, // screen px
  poi: 12,
  segment: 8,
  compose: 10,
  angleDeg: 7, // degrees within a 45° multiple to engage angle snap
  minDrag: 4, // screen px before a press becomes a drag
};

export type SnapResult =
  | { kind: "none"; point: Vec2 }
  | { kind: "node"; point: Vec2; node: NodeId }
  | { kind: "poi"; point: Vec2; poi: string }
  | { kind: "segment"; point: Vec2; edge: string; t: number }
  | { kind: "angle"; point: Vec2; angleDeg: number }
  | { kind: "angle-node"; point: Vec2; angleDeg: number; alignNode: NodeId }
  | { kind: "angle-segment"; point: Vec2; angleDeg: number; edge: string; t: number };
// reserved for later: "align" (x/y guides), "grid"

export interface SnapArgs {
  cursor: Vec2;
  /** The ACTIVE layer's graph only — walls tool snaps to walls, path tool to nav. */
  graph: Graph;
  /** Pass the floor's POIs only for the path tool (nav nodes may snap onto POIs). */
  pois?: Poi[];
  /** Chain tail position; null → angle snapping impossible. */
  anchor: Vec2 | null;
  zoom: number;
  /** Node being dragged (Select tool): excluded, along with its incident edges. */
  exclude?: NodeId;
  shift: boolean;
  alt: boolean;
}

export function snap(args: SnapArgs): SnapResult {
  const { cursor, graph, anchor, zoom } = args;
  const tolNode = SNAP.node / zoom;
  const tolSeg = SNAP.segment / zoom;
  const tolComp = SNAP.compose / zoom;

  // Degenerate guard: prevents NaN directions and zero-length edges.
  if (anchor && dist(cursor, anchor) * zoom < 2) {
    return { kind: "none", point: { x: anchor.x, y: anchor.y } };
  }

  if (args.alt) {
    // Alt suppresses proximity snapping. Alt+Shift keeps the pure angle constraint.
    if (args.shift && anchor) return anglePath(args, tolNode, tolSeg, tolComp, true);
    return { kind: "none", point: { ...cursor } };
  }

  if (args.shift && anchor) return anglePath(args, tolNode, tolSeg, tolComp, false);

  // (a) node snap — wins over everything
  const n = nearestNode(graph, cursor, tolNode, args.exclude);
  if (n) return { kind: "node", point: { x: n.x, y: n.y }, node: n.id };

  // (a2) POI snap — path tool only; a linked POI resolves to its existing nav node
  if (args.pois) {
    let best: Poi | null = null;
    let bd = SNAP.poi / zoom;
    for (const poi of args.pois) {
      const d = dist(cursor, poi);
      if (d <= bd) {
        bd = d;
        best = poi;
      }
    }
    if (best) {
      if (best.navNodeId && graph.nodes[best.navNodeId]) {
        const ln = graph.nodes[best.navNodeId];
        return { kind: "node", point: { x: ln.x, y: ln.y }, node: ln.id };
      }
      return { kind: "poi", point: { x: best.x, y: best.y }, poi: best.id };
    }
  }

  // (b) segment snap
  const s = nearestSegment(graph, cursor, tolSeg, args.exclude);
  if (s) return { kind: "segment", point: s.point, edge: s.key, t: s.t };

  // (c) angle snap eligibility
  if (anchor) {
    const v = { x: cursor.x - anchor.x, y: cursor.y - anchor.y };
    const { dir } = nearest45(v);
    if (angleDeltaDeg(v, dir) <= SNAP.angleDeg) {
      return anglePath(args, tolNode, tolSeg, tolComp, false);
    }
  }

  return { kind: "none", point: { ...cursor } };
}

function nearestNode(
  g: Graph,
  p: Vec2,
  tol: number,
  exclude?: NodeId,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bd = tol;
  for (const n of Object.values(g.nodes)) {
    if (n.id === exclude) continue;
    const d = dist(p, n);
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

function nearestSegment(
  g: Graph,
  p: Vec2,
  tol: number,
  exclude?: NodeId,
): { key: string; point: Vec2; t: number } | null {
  let best: { key: string; point: Vec2; t: number } | null = null;
  let bd = tol;
  for (const [key, e] of Object.entries(g.edges)) {
    if (exclude && (e.a === exclude || e.b === exclude)) continue;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    if (!A || !B) continue;
    const proj = projectPointOnSegment(p, A, B);
    const d = dist(p, proj.point);
    if (d <= bd) {
      bd = d;
      best = { key, point: proj.point, t: proj.t };
    }
  }
  return best;
}

/** Angle-locked path: project the cursor onto the nearest-45° ray from the anchor,
 *  then try the three compositions (node-on-ray, ray×segment, perpendicular foot). */
function anglePath(
  args: SnapArgs,
  tolNode: number,
  tolSeg: number,
  tolComp: number,
  skipCompositions: boolean,
): SnapResult {
  const { cursor, graph } = args;
  const anchor = args.anchor!;
  const v = { x: cursor.x - anchor.x, y: cursor.y - anchor.y };
  const { angleDeg, dir } = nearest45(v);
  const proj = Math.max(0, v.x * dir.x + v.y * dir.y);
  const base = { x: anchor.x + dir.x * proj, y: anchor.y + dir.y * proj };

  if (!skipCompositions) {
    // (a) node lying on the ray → full node snap (chain terminates exactly on it)
    let bestN: GraphNode | null = null;
    let bestNd = Infinity;
    for (const node of Object.values(graph.nodes)) {
      if (node.id === args.exclude) continue;
      const t = (node.x - anchor.x) * dir.x + (node.y - anchor.y) * dir.y;
      if (t <= 1e-9) continue;
      const foot = { x: anchor.x + dir.x * t, y: anchor.y + dir.y * t };
      if (dist(node, foot) > tolNode) continue;
      if (Math.abs(t - proj) > tolNode) continue;
      const d = dist(node, cursor);
      if (d < bestNd) {
        bestNd = d;
        bestN = node;
      }
    }
    if (bestN) return { kind: "node", point: { x: bestN.x, y: bestN.y }, node: bestN.id };

    // (b) ray × segment intersection → exact 45°/90° junction into an existing edge
    let bestX: { point: Vec2; key: string; t: number } | null = null;
    let bestXd = Infinity;
    for (const [key, e] of Object.entries(graph.edges)) {
      if (args.exclude && (e.a === args.exclude || e.b === args.exclude)) continue;
      const A = graph.nodes[e.a];
      const B = graph.nodes[e.b];
      if (!A || !B) continue;
      const hit = raySegmentIntersection(anchor, dir, A, B);
      if (!hit || hit.rayT < 1e-6) continue;
      const d = dist(hit.point, base);
      if (d <= tolSeg && d < bestXd) {
        bestXd = d;
        bestX = { point: hit.point, key, t: hit.segT };
      }
    }
    if (bestX) {
      return { kind: "angle-segment", point: bestX.point, angleDeg, edge: bestX.key, t: bestX.t };
    }

    // (c) perpendicular foot of a nearby node → aligned with N while square to the anchor
    let bestF: { q: Vec2; node: NodeId } | null = null;
    let bestFd = Infinity;
    for (const node of Object.values(graph.nodes)) {
      if (node.id === args.exclude) continue;
      if (dist(node, cursor) > tolComp) continue;
      const t = (node.x - anchor.x) * dir.x + (node.y - anchor.y) * dir.y;
      if (t <= 1e-9) continue;
      const q = { x: anchor.x + dir.x * t, y: anchor.y + dir.y * t };
      const d = dist(q, base);
      if (d <= tolComp && d < bestFd) {
        bestFd = d;
        bestF = { q, node: node.id };
      }
    }
    if (bestF) {
      return { kind: "angle-node", point: bestF.q, angleDeg, alignNode: bestF.node };
    }
  }

  return { kind: "angle", point: base, angleDeg };
}
