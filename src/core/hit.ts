// Hit-testing for the Select tool. Only ever tests the ACTIVE layer, with
// screen-pixel tolerances: nodes beat edges beat room fills.
import type { Floor, GraphNode, Poi, Room, Vec2 } from "./model";
import type { ItemRef, LayerId } from "./store";
import { dist, pointInPolygon, polygonSignedArea, projectPointOnSegment } from "./geometry";
import { SNAP } from "./snap";

export function hitTest(floor: Floor, layer: LayerId, p: Vec2, zoom: number): ItemRef | null {
  const tolNode = SNAP.node / zoom;
  const tolEdge = SNAP.segment / zoom;

  if (layer === "pois") {
    let best: Poi | null = null;
    let bd = Infinity;
    for (const poi of Object.values(floor.pois)) {
      const dc = dist(p, poi);
      let d = dc <= tolNode ? dc : Infinity;
      // Spanned doors are also hit anywhere along their line.
      if (poi.span) {
        for (let i = 0; i + 1 < poi.span.length; i++) {
          const A = floor.walls.nodes[poi.span[i]];
          const B = floor.walls.nodes[poi.span[i + 1]];
          if (!A || !B) continue;
          const dl = dist(p, projectPointOnSegment(p, A, B).point);
          if (dl <= tolEdge) d = Math.min(d, dl);
        }
      }
      if (d < bd) {
        bd = d;
        best = poi;
      }
    }
    return best ? { kind: "poi", id: best.id } : null;
  }

  const g = layer === "walls" ? floor.walls : floor.nav;

  let bn: GraphNode | null = null;
  let bnd = tolNode;
  for (const n of Object.values(g.nodes)) {
    const d = dist(p, n);
    if (d <= bnd) {
      bnd = d;
      bn = n;
    }
  }
  if (bn) return { kind: "node", layer, id: bn.id };

  let be: string | null = null;
  let bed = tolEdge;
  for (const [k, e] of Object.entries(g.edges)) {
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    if (!A || !B) continue;
    const proj = projectPointOnSegment(p, A, B);
    const d = dist(p, proj.point);
    if (d <= bed) {
      bed = d;
      be = k;
    }
  }
  if (be) return { kind: "edge", layer, key: be };

  if (layer === "walls") {
    let br: Room | null = null;
    let ba = Infinity;
    for (const r of Object.values(floor.rooms)) {
      const pts = r.loop.map((id) => floor.walls.nodes[id]).filter(Boolean);
      if (pts.length < 3 || pts.length !== r.loop.length) continue;
      if (!pointInPolygon(p, pts)) continue;
      const area = Math.abs(polygonSignedArea(pts));
      if (area < ba) {
        ba = area;
        br = r;
      }
    }
    if (br) return { kind: "room", id: br.id };
  }

  return null;
}
