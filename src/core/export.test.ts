import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildExport } from "./export";

/** Two floors: a wall square with a spanned door (emergency-only, linked to
 *  another building) + a 2-node nav path + POI + room on F1, one nav node on F2,
 *  joined by a one-way escalator. Fully connected, calibrated, building id set. */
function sampleProject() {
  const p = M.newProject();
  p.buildingId = "science-hall";
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
  f1.pois.pdoor = {
    id: "pdoor",
    x: 50,
    y: 100,
    type: "door",
    name: "Bridge door",
    span: ["C", "D"],
    access: "emergency_only",
    navNodeId: "n2",
    externalLink: { building: "library", key: "bridge-1", kind: "bridge" },
  };
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

const has = (warnings: { message: string }[], text: string) =>
  warnings.some((w) => w.message.includes(text));

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
    expect(json.schemaVersion).toBe(2);
    expect(json.buildingId).toBe("science-hall");
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
    // fully connected + calibrated + imaged + every door spanned → no warnings at all
    expect(warnings).toEqual([]);
  });

  it("exports doors as lines with access and the cross-building link index", () => {
    const { p, f1: floor1 } = sampleProject();
    const { json } = buildExport(p);
    const door = json.floors[0].pois.find((x) => x.id === "pdoor")!;
    expect(door).toEqual({
      id: "pdoor",
      x: 50,
      y: 100,
      type: "door",
      name: "Bridge door",
      navNodeId: "n2",
      line: [
        [100, 100],
        [0, 100],
      ],
      access: "emergency_only",
      externalLink: { building: "library", key: "bridge-1", kind: "bridge" },
    });
    expect(json.externalLinks).toEqual([
      { floor: floor1.id, poi: "pdoor", navNode: "n2", building: "library", key: "bridge-1", kind: "bridge" },
    ]);
  });

  it("exports a door whose span broke as a point, with a warning", () => {
    const { p, f1 } = sampleProject();
    f1.pois.pdoor.span = ["C", "A"]; // not a wall edge
    const { json, warnings } = buildExport(p);
    const door = json.floors[0].pois.find((x) => x.id === "pdoor")!;
    expect(door.line).toBeUndefined();
    expect(has(warnings, "lost its wall span")).toBe(true);
  });

  it("warns on point doors and notes door edges that have no POI", () => {
    const { p, f1 } = sampleProject();
    delete f1.pois.pdoor.span;
    const { warnings } = buildExport(p);
    expect(has(warnings, "is a point")).toBe(true);
    expect(warnings.some((w) => w.level === "info" && w.message.includes("door edge"))).toBe(true);
  });

  it("notes a span over an edge that lost its door tag", () => {
    const { p, f1 } = sampleProject();
    delete f1.walls.edges[M.edgeKey("C", "D")].kind;
    const { warnings } = buildExport(p);
    expect(warnings.some((w) => w.level === "info" && w.message.includes('not tagged "door"'))).toBe(true);
  });

  it("warns on types outside the org vocabulary (one list for points and rooms)", () => {
    const { p, f1 } = sampleProject();
    f1.pois.pf.type = "exit";
    f1.pois.proom.type = "stairs"; // a room can be any POI type
    const { warnings, json } = buildExport(p);
    expect(has(warnings, 'type "exit"')).toBe(true);
    expect(has(warnings, "stairs")).toBe(false);
    expect(json.floors[0].rooms[0].type).toBe("stairs");
  });

  it("validates cross-building links", () => {
    const base = sampleProject();
    delete base.f1.pois.pdoor.navNodeId;
    expect(has(buildExport(base.p).warnings, "has no nav node")).toBe(true);

    const dup = sampleProject();
    dup.f1.pois.pf.externalLink = { building: "library", key: "bridge-1" };
    expect(has(buildExport(dup.p).warnings, "keys must be unique")).toBe(true);
    expect(buildExport(dup.p).json.externalLinks).toHaveLength(2);

    const self = sampleProject();
    self.f1.pois.pdoor.externalLink!.building = "science-hall";
    expect(has(buildExport(self.p).warnings, "same building")).toBe(true);

    const incomplete = sampleProject();
    incomplete.f1.pois.pdoor.externalLink!.key = "";
    expect(has(buildExport(incomplete.p).warnings, "incomplete building link")).toBe(true);

    const noId = sampleProject();
    noId.p.buildingId = "";
    const r = buildExport(noId.p);
    expect(r.json.buildingId).toBe("");
    expect(r.warnings.some((w) => w.level === "warn" && w.message.includes("No building id"))).toBe(true);
  });

  it("only notes a missing building id when nothing links out", () => {
    const { p, f1 } = sampleProject();
    p.buildingId = "";
    delete f1.pois.pdoor.externalLink;
    const { warnings } = buildExport(p);
    expect(warnings.some((w) => w.level === "info" && w.message.includes("No building id"))).toBe(true);
  });

  it("skips zero-length segments with a warning", () => {
    const { p, f1 } = sampleProject();
    M.addNode(f1.walls, { x: 200, y: 200 }, "Z1");
    M.addNode(f1.walls, { x: 200, y: 200 }, "Z2");
    M.addEdge(f1.walls, "Z1", "Z2");
    const { json, warnings } = buildExport(p);
    expect(json.floors[0].walls).toHaveLength(4);
    expect(has(warnings, "zero-length wall")).toBe(true);
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
    expect(has(warnings, "missing floor/node")).toBe(true);
  });

  it("drops dangling POI nav links with a warning", () => {
    const { p, f1 } = sampleProject();
    f1.pois.pf.navNodeId = "deleted-node";
    const { json, warnings } = buildExport(p);
    const fountain = json.floors[0].pois.find((x) => x.type === "drinking_fountain");
    expect(fountain?.navNodeId).toBeUndefined();
    expect(has(warnings, "missing nav node")).toBe(true);
  });

  it("warns on orphan nav nodes and disconnected components", () => {
    const { p, f1 } = sampleProject();
    M.addNode(f1.nav, { x: 500, y: 500 }, "island");
    const { warnings } = buildExport(p);
    expect(has(warnings, "Orphan nav node island")).toBe(true);
    expect(has(warnings, "disconnected parts")).toBe(true);
  });

  it("bakes a customized room-POI type into the room entry", () => {
    const { p, f1 } = sampleProject();
    f1.pois.proom.type = "escalator";
    const { json } = buildExport(p);
    expect(json.floors[0].rooms[0].type).toBe("escalator");
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
    expect(has(warnings, "outline is broken")).toBe(true);
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
    expect(has(warnings, "broken boundary")).toBe(true);
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
