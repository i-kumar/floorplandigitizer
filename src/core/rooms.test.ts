import { describe, expect, it } from "vitest";
import { emptyGraph, type Graph, type Vec2 } from "./model";
import { polygonSignedArea } from "./geometry";
import { canonicalLoopKey, faceAtPoint, outerBoundary, traceFaces } from "./rooms";

function graphWith(nodes: Record<string, Vec2>, edges: Array<[string, string]>): Graph {
  const g = emptyGraph();
  for (const [id, p] of Object.entries(nodes)) g.nodes[id] = { id, x: p.x, y: p.y };
  for (const [a, b] of edges) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    g.edges[key] = { a, b };
  }
  return g;
}

const square = () =>
  graphWith(
    {
      A: { x: 0, y: 0 },
      B: { x: 100, y: 0 },
      C: { x: 100, y: 100 },
      D: { x: 0, y: 100 },
    },
    [
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["D", "A"],
    ],
  );

describe("traceFaces", () => {
  it("finds the single bounded face of a square", () => {
    const faces = traceFaces(square());
    expect(faces).toHaveLength(1);
    expect(faces[0].area).toBeCloseTo(10000);
    expect(faces[0].loop).toHaveLength(4);
  });

  it("finds two rooms sharing a wall", () => {
    const g = graphWith(
      {
        A: { x: 0, y: 0 },
        B: { x: 100, y: 0 },
        C: { x: 100, y: 100 },
        D: { x: 0, y: 100 },
        E: { x: 200, y: 0 },
        F: { x: 200, y: 100 },
      },
      [
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "A"],
        ["B", "E"],
        ["E", "F"],
        ["F", "C"],
      ],
    );
    const faces = traceFaces(g);
    expect(faces).toHaveLength(2);
    for (const f of faces) expect(f.area).toBeCloseTo(10000);
  });

  it("an open (unclosed) polyline produces no faces", () => {
    const g = graphWith(
      { A: { x: 0, y: 0 }, B: { x: 100, y: 0 }, C: { x: 100, y: 100 } },
      [
        ["A", "B"],
        ["B", "C"],
      ],
    );
    expect(traceFaces(g)).toHaveLength(0);
  });

  it("a stub wall inside a region does not break the face", () => {
    const g = square();
    g.nodes.S = { id: "S", x: 50, y: 0 };
    g.nodes.T = { id: "T", x: 50, y: 40 };
    // split the top edge conceptually: A-S, S-B replace A-B, plus stub S-T
    delete g.edges["A|B"];
    g.edges["A|S"] = { a: "A", b: "S" };
    g.edges["B|S"] = { a: "S", b: "B" };
    g.edges["S|T"] = { a: "S", b: "T" };
    const faces = traceFaces(g);
    expect(faces).toHaveLength(1);
    expect(faces[0].area).toBeCloseTo(10000); // the spike contributes zero area
    expect(faces[0].loop).toContain("T");
  });
});

describe("faceAtPoint", () => {
  it("picks the containing face", () => {
    const faces = traceFaces(square());
    const hit = faceAtPoint(square(), faces, { x: 50, y: 50 });
    expect(hit).not.toBeNull();
    const miss = faceAtPoint(square(), faces, { x: 150, y: 50 });
    expect(miss).toBeNull();
  });

  it("picks the smallest face when nested (separate components)", () => {
    const g = graphWith(
      {
        A: { x: 0, y: 0 },
        B: { x: 300, y: 0 },
        C: { x: 300, y: 300 },
        D: { x: 0, y: 300 },
        a: { x: 100, y: 100 },
        b: { x: 200, y: 100 },
        c: { x: 200, y: 200 },
        d: { x: 100, y: 200 },
      },
      [
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "A"],
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "a"],
      ],
    );
    const faces = traceFaces(g);
    expect(faces).toHaveLength(2);
    const inner = faceAtPoint(g, faces, { x: 150, y: 150 });
    expect(inner!.area).toBeCloseTo(10000);
    const outer = faceAtPoint(g, faces, { x: 50, y: 50 });
    expect(outer!.area).toBeCloseTo(90000);
  });
});

describe("outerBoundary", () => {
  it("returns the square's perimeter in positive orientation", () => {
    const g = square();
    const loop = outerBoundary(g)!;
    expect(loop).toHaveLength(4);
    expect(new Set(loop)).toEqual(new Set(["A", "B", "C", "D"]));
    const pts = loop.map((id) => g.nodes[id]);
    expect(polygonSignedArea(pts)).toBeCloseTo(10000); // same orientation as room loops
  });

  it("returns the hull of two adjacent rooms, not either room", () => {
    const g = graphWith(
      {
        A: { x: 0, y: 0 },
        B: { x: 100, y: 0 },
        C: { x: 100, y: 100 },
        D: { x: 0, y: 100 },
        E: { x: 200, y: 0 },
        F: { x: 200, y: 100 },
      },
      [
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "A"],
        ["B", "E"],
        ["E", "F"],
        ["F", "C"],
      ],
    );
    const loop = outerBoundary(g)!;
    expect(new Set(loop)).toEqual(new Set(["A", "B", "E", "F", "C", "D"]));
    expect(polygonSignedArea(loop.map((id) => g.nodes[id]))).toBeCloseTo(20000);
  });

  it("returns null for an open (unclosed) polyline", () => {
    const g = graphWith(
      { A: { x: 0, y: 0 }, B: { x: 100, y: 0 }, C: { x: 100, y: 100 } },
      [
        ["A", "B"],
        ["B", "C"],
      ],
    );
    expect(outerBoundary(g)).toBeNull();
  });

  it("picks the largest closed component", () => {
    const g = graphWith(
      {
        A: { x: 0, y: 0 },
        B: { x: 300, y: 0 },
        C: { x: 300, y: 300 },
        D: { x: 0, y: 300 },
        a: { x: 100, y: 100 },
        b: { x: 200, y: 100 },
        c: { x: 200, y: 200 },
        d: { x: 100, y: 200 },
      },
      [
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "A"],
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "a"],
      ],
    );
    const loop = outerBoundary(g)!;
    expect(new Set(loop)).toEqual(new Set(["A", "B", "C", "D"]));
  });
});

describe("canonicalLoopKey", () => {
  it("is rotation- and direction-invariant", () => {
    const k1 = canonicalLoopKey(["A", "B", "C", "D"]);
    const k2 = canonicalLoopKey(["C", "D", "A", "B"]);
    const k3 = canonicalLoopKey(["D", "C", "B", "A"]);
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
    expect(k1).not.toBe(canonicalLoopKey(["A", "C", "B", "D"]));
  });
});
