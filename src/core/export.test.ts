import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildExport } from "./export";

/** Two floors: a wall square with a door edge + a 2-node nav path + POI + room on F1,
 *  one nav node on F2, joined by a one-way escalator. Fully connected, calibrated. */
function sampleProject() {
  const p = M.newProject();
  const f1 = p.floors[0];
  const f2 = M.newFloor(p, "Floor 2");
  p.floors.push(f2);

  for (const [id, pt] of Object.entries({
    A: { x: 0, y: 0 },
    B: { x: 100, y: 0 },
    C: { x: 100, y: 100 },
    D: { x: 0, y: 100 },
  })) {
    M.addNode(f1.walls, pt, id);
  }
  M.addEdge(f1.walls, "A", "B");
  M.addEdge(f1.walls, "B", "C");
  M.addEdge(f1.walls, "C", "D", "door");
  M.addEdge(f1.walls, "D", "A");
  f1.rooms.r1 = { id: "r1", name: "Lobby", loop: ["A", "B", "C", "D"], poiId: "proom" };
  f1.pois.proom = { id: "proom", x: 50, y: 50, type: "room", name: "Lobby", roomId: "r1" };

  f1.outline = ["A", "B", "C", "D"];

  M.addNode(f1.nav, { x: 10.111, y: 20.222 }, "n1");
  M.addNode(f1.nav, { x: 90, y: 20 }, "n2");
  M.addEdge(f1.nav, "n1", "n2", "accessible");
  f1.pois.pf = { id: "pf", x: 10.111, y: 20.222, type: "drinking_fountain", navNodeId: "n1" };
  f1.pxPerMeter = 40;
  f1.image = { dataUrl: "data:,x", width: 1000, height: 800 };

  M.addNode(f2.nav, { x: 5, y: 5 }, "m1");
  for (const [id, pt] of Object.entries({
    W1: { x: 0, y: 0 },
    W2: { x: 50, y: 0 },
    W3: { x: 50, y: 50 },
  })) {
    M.addNode(f2.walls, pt, id);
  }
  M.addEdge(f2.walls, "W1", "W2");
  M.addEdge(f2.walls, "W2", "W3");
  M.addEdge(f2.walls, "W3", "W1");
  f2.outline = ["W1", "W2", "W3"];
  f2.pxPerMeter = 40;
  f2.image = { dataUrl: "data:,y", width: 1000, height: 800 };
  p.interFloorEdges.push({
    from: { floor: f1.id, node: "n2" },
    to: { floor: f2.id, node: "m1" },
    kind: "escalator",
    oneWay: true,
  });
  return { p, f1, f2 };
}

describe("buildExport", () => {
  it("flattens walls with kinds and rounds coordinates", () => {
    const { p } = sampleProject();
    const { json } = buildExport(p);
    const f1 = json.floors[0];
    expect(f1.walls).toHaveLength(4);
    const door = f1.walls.find((w) => w.kind === "door");
    expect(door).toBeDefined();
    expect(f1.nav.nodes.find((n) => n.id === "n1")).toEqual({ id: "n1", x: 10.11, y: 20.22 });
    expect(f1.width).toBe(1000);
    expect(f1.pxPerMeter).toBe(40);
  });

  it("exports the nav graph, POI links, rooms, and inter-floor tuples", () => {
    const { p, f1: floor1, f2: floor2 } = sampleProject();
    const { json, warnings } = buildExport(p);
    const f1 = json.floors[0];
    expect(f1.nav.edges).toEqual([{ from: "n1", to: "n2", kind: "accessible" }]);
    const fountain = f1.pois.find((x) => x.type === "drinking_fountain");
    expect(fountain?.navNodeId).toBe("n1");
    const roomPoi = f1.pois.find((x) => x.type === "room");
    expect(roomPoi?.roomId).toBe("r1");
    expect(f1.rooms).toHaveLength(1);
    expect(f1.rooms[0].type).toBe("room");
    expect(f1.rooms[0].polygon).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    expect(f1.outline).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    expect(json.interFloorEdges).toEqual([
      { from: [floor1.id, "n2"], to: [floor2.id, "m1"], kind: "escalator", oneWay: true },
    ]);
    // fully connected + calibrated + imaged → no warnings at all
    expect(warnings).toEqual([]);
  });

  it("skips zero-length segments with a warning", () => {
    const { p, f1 } = sampleProject();
    M.addNode(f1.walls, { x: 200, y: 200 }, "Z1");
    M.addNode(f1.walls, { x: 200, y: 200 }, "Z2");
    M.addEdge(f1.walls, "Z1", "Z2");
    const { json, warnings } = buildExport(p);
    expect(json.floors[0].walls).toHaveLength(4);
    expect(warnings.some((w) => w.message.includes("zero-length wall"))).toBe(true);
  });

  it("drops dangling inter-floor links with a warning", () => {
    const { p, f1 } = sampleProject();
    p.interFloorEdges.push({
      from: { floor: f1.id, node: "ghost" },
      to: { floor: "nope", node: "m1" },
      kind: "stairs",
      oneWay: false,
    });
    const { json, warnings } = buildExport(p);
    expect(json.interFloorEdges).toHaveLength(1);
    expect(warnings.some((w) => w.message.includes("missing floor/node"))).toBe(true);
  });

  it("drops dangling POI nav links with a warning", () => {
    const { p, f1 } = sampleProject();
    f1.pois.pf.navNodeId = "deleted-node";
    const { json, warnings } = buildExport(p);
    const fountain = json.floors[0].pois.find((x) => x.type === "drinking_fountain");
    expect(fountain?.navNodeId).toBeUndefined();
    expect(warnings.some((w) => w.message.includes("missing nav node"))).toBe(true);
  });

  it("warns on orphan nav nodes and disconnected components", () => {
    const { p, f1 } = sampleProject();
    M.addNode(f1.nav, { x: 500, y: 500 }, "island");
    const { warnings } = buildExport(p);
    expect(warnings.some((w) => w.message.includes("Orphan nav node island"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("disconnected parts"))).toBe(true);
  });

  it("bakes a customized room-POI type into the room entry", () => {
    const { p, f1 } = sampleProject();
    f1.pois.proom.type = "classroom";
    const { json } = buildExport(p);
    expect(json.floors[0].rooms[0].type).toBe("classroom");
  });

  it("accepts edge-less outlines and normalizes winding to room orientation", () => {
    const { p, f1 } = sampleProject();
    f1.outline = ["A", "C", "B"]; // A-C is not a wall edge; clicked "backwards"
    const { json } = buildExport(p);
    expect(json.floors[0].outline).toEqual([
      [100, 0],
      [100, 100],
      [0, 0],
    ]);
  });

  it("warns on an outline with a missing node and exports it as null", () => {
    const { p, f1 } = sampleProject();
    f1.outline = ["A", "C", "ghost"];
    const { json, warnings } = buildExport(p);
    expect(json.floors[0].outline).toBeNull();
    expect(warnings.some((w) => w.message.includes("outline is broken"))).toBe(true);
  });

  it("notes a missing outline at info level", () => {
    const { p, f1 } = sampleProject();
    f1.outline = null;
    const { json, warnings } = buildExport(p);
    expect(json.floors[0].outline).toBeNull();
    expect(
      warnings.some((w) => w.level === "info" && w.message.includes("no building outline")),
    ).toBe(true);
  });

  it("warns on broken room loops and skips them", () => {
    const { p, f1 } = sampleProject();
    f1.rooms.r1.loop = ["A", "C", "B"]; // A-C is not an edge
    const { json, warnings } = buildExport(p);
    expect(json.floors[0].rooms).toHaveLength(0);
    expect(warnings.some((w) => w.message.includes("broken boundary"))).toBe(true);
  });

  it("emits info notes for uncalibrated / imageless floors", () => {
    const p = M.newProject();
    const { warnings } = buildExport(p);
    expect(warnings.some((w) => w.level === "info" && w.message.includes("no floor plan"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.level === "info" && w.message.includes("not calibrated"))).toBe(
      true,
    );
  });
});
