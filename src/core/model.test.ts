import { describe, expect, it } from "vitest";
import * as M from "./model";

/** Project with one floor holding a wall square A-B-C-D registered as room r1. */
function projectWithRoom() {
  const p = M.newProject();
  const f = p.floors[0];
  const pts: Record<string, M.Vec2> = {
    A: { x: 0, y: 0 },
    B: { x: 100, y: 0 },
    C: { x: 100, y: 100 },
    D: { x: 0, y: 100 },
  };
  for (const [id, pt] of Object.entries(pts)) M.addNode(f.walls, pt, id);
  M.addEdge(f.walls, "A", "B");
  M.addEdge(f.walls, "B", "C");
  M.addEdge(f.walls, "C", "D");
  M.addEdge(f.walls, "D", "A");
  f.rooms.r1 = { id: "r1", name: "Room 1", loop: ["A", "B", "C", "D"], poiId: "p1" };
  f.pois.p1 = { id: "p1", x: 50, y: 50, type: "room", name: "Room 1", roomId: "r1" };
  return { p, f };
}

describe("graph basics", () => {
  it("rejects self-edges and duplicates", () => {
    const g = M.emptyGraph();
    M.addNode(g, { x: 0, y: 0 }, "a");
    M.addNode(g, { x: 1, y: 1 }, "b");
    expect(M.addEdge(g, "a", "a")).toBe(false);
    expect(M.addEdge(g, "a", "b")).toBe(true);
    expect(M.addEdge(g, "b", "a")).toBe(false); // same canonical key
    expect(Object.keys(g.edges)).toHaveLength(1);
  });

  it("splitEdge preserves kind and rewires", () => {
    const g = M.emptyGraph();
    M.addNode(g, { x: 0, y: 0 }, "a");
    M.addNode(g, { x: 10, y: 0 }, "b");
    M.addEdge(g, "a", "b", "door");
    M.splitEdge(g, M.edgeKey("a", "b"), { x: 5, y: 0 }, "m");
    expect(g.edges[M.edgeKey("a", "b")]).toBeUndefined();
    expect(g.edges[M.edgeKey("a", "m")]?.kind).toBe("door");
    expect(g.edges[M.edgeKey("m", "b")]?.kind).toBe("door");
    expect(g.nodes.m).toEqual({ id: "m", x: 5, y: 0 });
  });

  it("deleteNodeCascade removes incident edges and sweeps orphans", () => {
    const g = M.emptyGraph();
    M.addNode(g, { x: 0, y: 0 }, "a");
    M.addNode(g, { x: 10, y: 0 }, "b");
    M.addNode(g, { x: 20, y: 0 }, "c");
    M.addEdge(g, "a", "b");
    M.addEdge(g, "b", "c");
    const removed = M.deleteNodeCascade(g, "b");
    expect(new Set(removed)).toEqual(new Set(["a", "b", "c"])); // a and c became degree-0
    expect(Object.keys(g.nodes)).toHaveLength(0);
    expect(Object.keys(g.edges)).toHaveLength(0);
  });

  it("mergeNodes rewires and collapses duplicates/self-edges", () => {
    const g = M.emptyGraph();
    for (const [id, x] of [
      ["a", 0],
      ["b", 10],
      ["c", 20],
    ] as const) {
      M.addNode(g, { x, y: 0 }, id);
    }
    M.addEdge(g, "a", "b");
    M.addEdge(g, "b", "c");
    M.addEdge(g, "a", "c");
    M.mergeNodes(g, "a", "b"); // a-b becomes self (dropped); b-c becomes a-c (duplicate)
    expect(g.nodes.b).toBeUndefined();
    expect(Object.keys(g.edges)).toEqual([M.edgeKey("a", "c")]);
  });
});

describe("wall ↔ room ripple rules", () => {
  it("splitWallEdge inserts the new node into the room loop", () => {
    const { f } = projectWithRoom();
    M.splitWallEdge(f, M.edgeKey("A", "B"), { x: 50, y: 0 }, "m");
    expect(f.rooms.r1.loop).toEqual(["A", "m", "B", "C", "D"]);
    expect(M.loopEdgesValid(f, f.rooms.r1.loop)).toBe(true);
  });

  it("merging two corners keeps a still-valid room as a triangle", () => {
    const { f } = projectWithRoom();
    M.mergeWallNodes(f, "A", "D"); // drag D onto A
    expect(f.rooms.r1).toBeDefined();
    expect(f.rooms.r1.loop).toEqual(["A", "B", "C"]);
    expect(M.loopEdgesValid(f, f.rooms.r1.loop)).toBe(true);
  });

  it("deleting a boundary edge deletes the room and its POI", () => {
    const { f } = projectWithRoom();
    M.deleteWallEdge(f, M.edgeKey("A", "B"));
    expect(f.rooms.r1).toBeUndefined();
    expect(f.pois.p1).toBeUndefined();
    // A and B still have their other edges — not orphaned
    expect(f.walls.nodes.A).toBeDefined();
    expect(f.walls.nodes.B).toBeDefined();
  });

  it("deleting a corner node deletes the room", () => {
    const { f } = projectWithRoom();
    M.deleteWallNode(f, "C");
    expect(f.rooms.r1).toBeUndefined();
    expect(f.pois.p1).toBeUndefined();
  });

  it("deleting the room deletes its POI (and vice versa)", () => {
    const { p, f } = projectWithRoom();
    M.deleteRoom(f, "r1");
    expect(f.pois.p1).toBeUndefined();

    const again = projectWithRoom();
    M.deletePoi(again.p, again.f, "p1");
    expect(again.f.rooms.r1).toBeUndefined();
    expect(again.f.pois.p1).toBeUndefined();
    void p;
  });
});

describe("nav ripple rules", () => {
  function navProject() {
    const p = M.newProject();
    const f1 = p.floors[0];
    const f2 = M.newFloor(p, "Floor 2");
    p.floors.push(f2);
    M.addNode(f1.nav, { x: 0, y: 0 }, "n1");
    M.addNode(f1.nav, { x: 10, y: 0 }, "n2");
    M.addNode(f1.nav, { x: 20, y: 0 }, "n3");
    M.addEdge(f1.nav, "n1", "n2");
    M.addEdge(f1.nav, "n2", "n3");
    M.addNode(f2.nav, { x: 0, y: 0 }, "m1");
    p.interFloorEdges.push({
      from: { floor: f1.id, node: "n3" },
      to: { floor: f2.id, node: "m1" },
      kind: "stairs",
      oneWay: false,
    });
    f1.pois.pp = { id: "pp", x: 10, y: 0, type: "exit", navNodeId: "n2" };
    return { p, f1, f2 };
  }

  it("deleteNavNode prunes links and POI references of every swept node", () => {
    const { p, f1 } = navProject();
    M.deleteNavNode(p, f1, "n2"); // n1 and n3 become orphans and are swept too
    expect(Object.keys(f1.nav.nodes)).toHaveLength(0);
    expect(p.interFloorEdges).toHaveLength(0); // n3's link pruned
    expect(f1.pois.pp.navNodeId).toBeUndefined();
  });

  it("mergeNavNodes patches links and POI references onto the survivor", () => {
    const { p, f1 } = navProject();
    M.mergeNavNodes(p, f1, "n2", "n3"); // drop n3 onto n2
    expect(p.interFloorEdges[0].from.node).toBe("n2");
    expect(f1.nav.nodes.n3).toBeUndefined();
  });

  it("deleteNavEdge orphan-sweeps and cleans references", () => {
    const { p, f1 } = navProject();
    M.deleteNavEdge(p, f1, M.edgeKey("n2", "n3")); // n3 orphaned → swept → link pruned
    expect(f1.nav.nodes.n3).toBeUndefined();
    expect(p.interFloorEdges).toHaveLength(0);
    expect(f1.nav.nodes.n1).toBeDefined(); // still connected to n2
  });

  it("deleteFloor prunes its links and never leaves zero floors", () => {
    const { p, f2 } = navProject();
    M.deleteFloor(p, f2.id);
    expect(p.interFloorEdges).toHaveLength(0);
    expect(p.floors).toHaveLength(1);
    const onlyId = p.floors[0].id;
    M.deleteFloor(p, onlyId);
    expect(p.floors).toHaveLength(1);
    expect(p.floors[0].id).not.toBe(onlyId); // a fresh empty floor replaced it
  });
});

describe("addEdgeWithIntersections", () => {
  it("splits both segments at a single crossing", () => {
    const p = M.newProject();
    const f = p.floors[0];
    M.addNode(f.walls, { x: 0, y: 5 }, "c");
    M.addNode(f.walls, { x: 10, y: 5 }, "d");
    M.addEdge(f.walls, "c", "d", "door");
    M.addNode(f.walls, { x: 5, y: 0 }, "a");
    M.addNode(f.walls, { x: 5, y: 10 }, "b");
    M.addEdgeWithIntersections(p, f, "walls", "a", "b");
    // one new node at (5,5), four edges
    const nodes = Object.values(f.walls.nodes);
    expect(nodes).toHaveLength(5);
    const x = nodes.find((n) => !["a", "b", "c", "d"].includes(n.id))!;
    expect(x.x).toBeCloseTo(5);
    expect(x.y).toBeCloseTo(5);
    expect(Object.keys(f.walls.edges)).toHaveLength(4);
    expect(f.walls.edges[M.edgeKey("c", x.id)]?.kind).toBe("door"); // crossed edge keeps its kind
    expect(f.walls.edges[M.edgeKey("a", x.id)]?.kind).toBeUndefined();
  });

  it("splits at multiple crossings in order along the drawn segment", () => {
    const p = M.newProject();
    const f = p.floors[0];
    M.addNode(f.nav, { x: 3, y: -5 }, "c1");
    M.addNode(f.nav, { x: 3, y: 5 }, "d1");
    M.addEdge(f.nav, "c1", "d1");
    M.addNode(f.nav, { x: 7, y: -5 }, "c2");
    M.addNode(f.nav, { x: 7, y: 5 }, "d2");
    M.addEdge(f.nav, "c2", "d2");
    M.addNode(f.nav, { x: 0, y: 0 }, "a");
    M.addNode(f.nav, { x: 10, y: 0 }, "b");
    M.addEdgeWithIntersections(p, f, "nav", "a", "b");
    expect(Object.keys(f.nav.nodes)).toHaveLength(8); // 6 + 2 intersection nodes
    expect(Object.keys(f.nav.edges)).toHaveLength(7); // 2 verticals→4 + drawn→3
    // a's neighbor along the drawn line is the x=3 intersection
    const aEdges = M.edgesAt(f.nav, "a");
    expect(aEdges).toHaveLength(1);
    const e = f.nav.edges[aEdges[0]];
    const nbr = f.nav.nodes[e.a === "a" ? e.b : e.a];
    expect(nbr.x).toBeCloseTo(3);
  });

  it("crossing a room boundary patches the room loop", () => {
    const { p, f } = projectWithRoom();
    M.addNode(f.walls, { x: 50, y: -20 }, "s");
    M.addNode(f.walls, { x: 50, y: 50 }, "t");
    M.addEdgeWithIntersections(p, f, "walls", "s", "t"); // crosses top edge A-B
    expect(f.rooms.r1).toBeDefined();
    expect(f.rooms.r1.loop).toHaveLength(5); // intersection node inserted
    expect(M.loopEdgesValid(f, f.rooms.r1.loop)).toBe(true);
  });

  it("falls back to a plain edge when nothing crosses", () => {
    const p = M.newProject();
    const f = p.floors[0];
    M.addNode(f.walls, { x: 0, y: 0 }, "a");
    M.addNode(f.walls, { x: 10, y: 0 }, "b");
    M.addEdgeWithIntersections(p, f, "walls", "a", "b");
    expect(Object.keys(f.walls.edges)).toEqual([M.edgeKey("a", "b")]);
  });
});

describe("rescaleFloorGeometry", () => {
  it("scales nodes, POIs, and calibration uniformly", () => {
    const { f } = projectWithRoom();
    f.pxPerMeter = 40;
    M.rescaleFloorGeometry(f, 2, 2);
    expect(f.walls.nodes.B.x).toBe(200);
    expect(f.pois.p1.x).toBe(100);
    expect(f.pxPerMeter).toBe(80);
  });
  it("clears calibration on non-uniform scale", () => {
    const { f } = projectWithRoom();
    f.pxPerMeter = 40;
    M.rescaleFloorGeometry(f, 2, 3);
    expect(f.pxPerMeter).toBeNull();
    expect(f.walls.nodes.C.y).toBe(300);
  });
});

describe("ids and cloning", () => {
  it("ids carry the project prefix", () => {
    const p = M.newProject();
    const id = M.newId(p, "n");
    expect(id).toBe(`${p.idPrefix}-n${p.idCounter}`);
    expect(p.idPrefix).toHaveLength(4);
  });

  it("cloneProject shares image refs but deep-copies geometry", () => {
    const { p, f } = projectWithRoom();
    f.image = { dataUrl: "data:image/png;base64,xyz", width: 10, height: 10 };
    const clone = M.cloneProject(p);
    expect(clone.floors[0].image).toBe(f.image); // shared reference
    clone.floors[0].walls.nodes.A.x = 999;
    clone.floors[0].rooms.r1.loop.push("Z");
    expect(f.walls.nodes.A.x).toBe(0);
    expect(f.rooms.r1.loop).toHaveLength(4);
  });
});
