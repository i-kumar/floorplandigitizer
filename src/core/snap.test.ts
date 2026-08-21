import { describe, expect, it } from "vitest";
import { emptyGraph, type Graph, type Poi, type Vec2 } from "./model";
import { snap } from "./snap";

function graphWith(nodes: Record<string, Vec2>, edges: Array<[string, string]> = []): Graph {
  const g = emptyGraph();
  for (const [id, p] of Object.entries(nodes)) g.nodes[id] = { id, x: p.x, y: p.y };
  for (const [a, b] of edges) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    g.edges[key] = { a, b };
  }
  return g;
}

const base = { anchor: null, zoom: 1, shift: false, alt: false };

describe("proximity snapping", () => {
  it("node snap wins over segment snap", () => {
    const g = graphWith({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, [["a", "b"]]);
    const r = snap({ ...base, cursor: { x: 5, y: 3 }, graph: g });
    expect(r.kind).toBe("node");
    if (r.kind === "node") expect(r.node).toBe("a");
  });

  it("segment snap projects onto the edge", () => {
    const g = graphWith({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, [["a", "b"]]);
    const r = snap({ ...base, cursor: { x: 50, y: 5 }, graph: g });
    expect(r.kind).toBe("segment");
    expect(r.point).toEqual({ x: 50, y: 0 });
  });

  it("tolerances scale with zoom (same screen distance)", () => {
    const g = graphWith({ a: { x: 0, y: 0 } });
    // 20 image px from the node: out of range at zoom 1 (tol 12px)...
    expect(snap({ ...base, cursor: { x: 20, y: 0 }, graph: g }).kind).toBe("none");
    // ...but in range at zoom 0.5 (tol 24 image px)
    expect(snap({ ...base, cursor: { x: 20, y: 0 }, graph: g, zoom: 0.5 }).kind).toBe("node");
    expect(snap({ ...base, cursor: { x: 20, y: 0 }, graph: g, zoom: 2 }).kind).toBe("none");
  });

  it("alt disables proximity snapping", () => {
    const g = graphWith({ a: { x: 0, y: 0 } });
    const r = snap({ ...base, cursor: { x: 3, y: 3 }, graph: g, alt: true });
    expect(r.kind).toBe("none");
    expect(r.point).toEqual({ x: 3, y: 3 });
  });

  it("exclude skips the dragged node and its incident edges", () => {
    const g = graphWith({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, [["a", "b"]]);
    const r = snap({ ...base, cursor: { x: 2, y: 2 }, graph: g, exclude: "a" });
    // node a excluded; edge a-b excluded too, so nothing snaps
    expect(r.kind).toBe("none");
  });
});

describe("POI snapping (path tool)", () => {
  const pois: Poi[] = [{ id: "p1", x: 50, y: 50, type: "door" }];

  it("snaps onto an unlinked POI", () => {
    const r = snap({ ...base, cursor: { x: 55, y: 53 }, graph: emptyGraph(), pois });
    expect(r.kind).toBe("poi");
    expect(r.point).toEqual({ x: 50, y: 50 });
  });

  it("a linked POI resolves to its existing nav node", () => {
    const g = graphWith({ n9: { x: 52, y: 48 } });
    const linked: Poi[] = [{ id: "p1", x: 50, y: 50, type: "door", navNodeId: "n9" }];
    const r = snap({ ...base, cursor: { x: 55, y: 53 }, graph: g, pois: linked });
    expect(r.kind).toBe("node");
    if (r.kind === "node") expect(r.node).toBe("n9");
  });

  it("a dangling navNodeId falls back to a plain POI snap", () => {
    const linked: Poi[] = [{ id: "p1", x: 50, y: 50, type: "door", navNodeId: "gone" }];
    const r = snap({ ...base, cursor: { x: 52, y: 50 }, graph: emptyGraph(), pois: linked });
    expect(r.kind).toBe("poi");
  });
});

describe("angle snapping", () => {
  const anchor = { x: 0, y: 0 };

  it("engages within 7° of a 45° multiple", () => {
    const r = snap({ ...base, cursor: { x: 100, y: 8 }, graph: emptyGraph(), anchor });
    expect(r.kind).toBe("angle");
    if (r.kind === "angle") {
      expect(r.angleDeg).toBe(0);
      expect(r.point.x).toBeCloseTo(100);
      expect(r.point.y).toBeCloseTo(0);
    }
  });

  it("stays free outside the threshold", () => {
    const r = snap({ ...base, cursor: { x: 100, y: 20 }, graph: emptyGraph(), anchor });
    expect(r.kind).toBe("none");
  });

  it("projects onto the 45° diagonal", () => {
    const r = snap({ ...base, cursor: { x: 70, y: 74 }, graph: emptyGraph(), anchor });
    expect(r.kind).toBe("angle");
    if (r.kind === "angle") {
      expect(r.angleDeg).toBe(45);
      expect(r.point.x).toBeCloseTo(72);
      expect(r.point.y).toBeCloseTo(72);
    }
  });

  it("shift forces the lock even far from a multiple", () => {
    const r = snap({
      ...base,
      cursor: { x: 60, y: 25 },
      graph: emptyGraph(),
      anchor,
      shift: true,
    });
    expect(r.kind).toBe("angle");
    // atan2(25, 60) ≈ 22.6°, which rounds to the 45° multiple
    if (r.kind === "angle") expect(r.angleDeg).toBe(45);
  });

  it("degenerate cursor-on-anchor returns none at the anchor", () => {
    const r = snap({ ...base, cursor: { x: 0.5, y: 0.4 }, graph: emptyGraph(), anchor });
    expect(r.kind).toBe("none");
    expect(r.point).toEqual({ x: 0, y: 0 });
  });
});

describe("angle compositions", () => {
  const anchor = { x: 0, y: 0 };

  it("node-on-ray upgrades to a full node snap", () => {
    const g = graphWith({ t: { x: 100, y: 3 } });
    const r = snap({ ...base, cursor: { x: 98, y: 1 }, graph: g, anchor });
    expect(r.kind).toBe("node");
    if (r.kind === "node") {
      expect(r.node).toBe("t");
      expect(r.point).toEqual({ x: 100, y: 3 });
    }
  });

  it("shift + crossing edge → angle-segment at the exact intersection", () => {
    const g = graphWith({ a: { x: 50, y: -40 }, b: { x: 50, y: 40 } }, [["a", "b"]]);
    const r = snap({ ...base, cursor: { x: 47, y: 2 }, graph: g, anchor, shift: true });
    expect(r.kind).toBe("angle-segment");
    if (r.kind === "angle-segment") {
      expect(r.point.x).toBeCloseTo(50);
      expect(r.point.y).toBeCloseTo(0);
      expect(r.angleDeg).toBe(0);
    }
  });

  it("perpendicular foot of an off-ray node → angle-node", () => {
    const g = graphWith({ n: { x: 60, y: 14 } }); // 14px off-ray: too far for node-on-ray
    const r = snap({ ...base, cursor: { x: 58, y: 10 }, graph: g, anchor, shift: true });
    expect(r.kind).toBe("angle-node");
    if (r.kind === "angle-node") {
      expect(r.alignNode).toBe("n");
      expect(r.point.x).toBeCloseTo(60);
      expect(r.point.y).toBeCloseTo(0);
    }
  });

  it("alt+shift keeps the raw angle projection (no compositions)", () => {
    const g = graphWith({ t: { x: 100, y: 3 } });
    const r = snap({
      ...base,
      cursor: { x: 98, y: 1 },
      graph: g,
      anchor,
      shift: true,
      alt: true,
    });
    expect(r.kind).toBe("angle");
  });
});
