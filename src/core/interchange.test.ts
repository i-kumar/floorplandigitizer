import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildExport, type ExportJson } from "./export";
import { importMapJson, mergeProjectInto } from "./interchange";

/** Two floors: door-tagged wall square + room + linked POI + outline + nav on
 *  F1 (with an image), triangle walls + nav on F2 (no image), one-way escalator
 *  between them. Calibrated. `pre` prefixes the hand-written ids, mimicking the
 *  per-project id prefixes that keep separate files collision-free. */
function richProject(pre = "") {
  const id = (s: string) => pre + s;
  const p = M.newProject();
  const f1 = p.floors[0];
  const f2 = M.newFloor(p, "Floor 2");
  p.floors.push(f2);

  for (const [nid, pt] of Object.entries({
    A: { x: 0, y: 0 },
    B: { x: 100, y: 0 },
    C: { x: 100, y: 100 },
    D: { x: 0, y: 100 },
  })) {
    M.addNode(f1.walls, pt, id(nid));
  }
  M.addEdge(f1.walls, id("A"), id("B"));
  M.addEdge(f1.walls, id("B"), id("C"), "door");
  M.addEdge(f1.walls, id("C"), id("D"));
  M.addEdge(f1.walls, id("D"), id("A"));
  f1.rooms[id("r1")] = {
    id: id("r1"),
    name: "Lobby",
    loop: [id("A"), id("B"), id("C"), id("D")],
    poiId: id("proom"),
  };
  f1.pois[id("proom")] = {
    id: id("proom"),
    x: 50,
    y: 50,
    type: "classroom",
    name: "Lobby",
    roomId: id("r1"),
  };
  f1.outline = [id("A"), id("B"), id("C"), id("D")];
  M.addNode(f1.nav, { x: 10, y: 20 }, id("n1"));
  M.addNode(f1.nav, { x: 90, y: 20 }, id("n2"));
  M.addEdge(f1.nav, id("n1"), id("n2"), "accessible");
  f1.pois[id("pf")] = {
    id: id("pf"),
    x: 10,
    y: 20,
    type: "drinking_fountain",
    name: "F",
    navNodeId: id("n1"),
  };
  f1.pxPerMeter = 40;
  f1.image = { dataUrl: "data:,x", width: 1000, height: 800 };

  for (const [nid, pt] of Object.entries({
    W1: { x: 0, y: 0 },
    W2: { x: 50, y: 0 },
    W3: { x: 50, y: 50 },
  })) {
    M.addNode(f2.walls, pt, id(nid));
  }
  M.addEdge(f2.walls, id("W1"), id("W2"));
  M.addEdge(f2.walls, id("W2"), id("W3"));
  M.addEdge(f2.walls, id("W3"), id("W1"));
  f2.outline = [id("W1"), id("W2"), id("W3")];
  M.addNode(f2.nav, { x: 5, y: 5 }, id("m1"));
  p.interFloorEdges.push({
    from: { floor: f1.id, node: id("n2") },
    to: { floor: f2.id, node: id("m1") },
    kind: "escalator",
    oneWay: true,
  });
  return { p, f1, f2 };
}

const sortSegs = <T,>(arr: T[]) =>
  [...arr].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("importMapJson", () => {
  it("export → import → export is a fixed point", () => {
    const { p } = richProject();
    const first = buildExport(p).json;
    const { project: rebuilt, warnings } = importMapJson(first);
    expect(warnings).toEqual([]);
    const second = buildExport(rebuilt).json;

    expect(second.building).toBe(first.building);
    expect(second.interFloorEdges).toEqual(first.interFloorEdges);
    expect(second.floors).toHaveLength(first.floors.length);
    for (let i = 0; i < first.floors.length; i++) {
      const a = first.floors[i];
      const b = second.floors[i];
      expect(b.id).toBe(a.id);
      expect(b.name).toBe(a.name);
      expect(b.pxPerMeter).toBe(a.pxPerMeter);
      expect(b.width).toBe(a.width); // survives via expectedImageSize
      expect(b.height).toBe(a.height);
      expect(sortSegs(b.walls)).toEqual(sortSegs(a.walls));
      expect(sortSegs(b.nav.nodes)).toEqual(sortSegs(a.nav.nodes)); // ids preserved
      expect(sortSegs(b.nav.edges)).toEqual(sortSegs(a.nav.edges));
      expect(sortSegs(b.pois)).toEqual(sortSegs(a.pois));
      expect(sortSegs(b.rooms)).toEqual(sortSegs(a.rooms)); // incl. type + polygon
      expect(b.outline).toEqual(a.outline);
    }
  });

  it("welds wall segment endpoints back into shared nodes", () => {
    const { p } = richProject();
    const { project: rebuilt } = importMapJson(buildExport(p).json);
    const walls = rebuilt.floors[0].walls;
    expect(Object.keys(walls.nodes)).toHaveLength(4); // square: 4 nodes, not 8
    expect(Object.keys(walls.edges)).toHaveLength(4);
    expect(Object.values(walls.edges).filter((e) => e.kind === "door")).toHaveLength(1);
    // the rebuilt room loop is a real closed cycle over those nodes
    const room = Object.values(rebuilt.floors[0].rooms)[0];
    expect(M.loopEdgesValid(rebuilt.floors[0], room.loop)).toBe(true);
    // recovered floors expect their original raster size
    expect(rebuilt.floors[0].expectedImageSize).toEqual({ width: 1000, height: 800 });
    expect(rebuilt.floors[1].expectedImageSize).toBeUndefined();
  });

  it("keeps nav/POI/room ids stable and uses a fresh prefix for minted wall nodes", () => {
    const { p } = richProject();
    const { project: rebuilt } = importMapJson(buildExport(p).json);
    const f1 = rebuilt.floors[0];
    expect(f1.nav.nodes.n1).toBeDefined();
    expect(f1.pois.pf.navNodeId).toBe("n1");
    expect(f1.pois.proom.roomId).toBe("r1");
    expect(f1.rooms.r1.poiId).toBe("proom");
    for (const id of Object.keys(f1.walls.nodes)) {
      expect(id.startsWith(`${rebuilt.idPrefix}-`)).toBe(true);
    }
    expect(rebuilt.idPrefix).not.toBe(p.idPrefix);
    expect(rebuilt.poiTypes).toContain("classroom");
  });

  it("drops an unmatchable room with a warning and clears its POI's roomId", () => {
    const { p } = richProject();
    const json = buildExport(p).json as ExportJson;
    json.floors[0].rooms[0].polygon[1] = [999, 999]; // no wall corner there
    const { project: rebuilt, warnings } = importMapJson(json);
    expect(Object.keys(rebuilt.floors[0].rooms)).toHaveLength(0);
    expect(rebuilt.floors[0].pois.proom.roomId).toBeUndefined();
    expect(warnings.some((w) => w.includes("Lobby"))).toBe(true);
  });

  it("throws on non-map input", () => {
    expect(() => importMapJson({ hello: 1 })).toThrow();
    expect(() => importMapJson(null)).toThrow();
  });
});

describe("mergeProjectInto", () => {
  it("appends floors, links, and poiTypes from another project", () => {
    const target = richProject().p;
    const source = richProject("z-").p; // distinct ids, as real prefixes guarantee
    source.poiTypes.push("locker");
    const before = target.floors.length;
    mergeProjectInto(target, source);
    expect(target.floors).toHaveLength(before + 2);
    expect(target.interFloorEdges).toHaveLength(2); // one internal link from each
    expect(target.poiTypes).toContain("locker");
  });

  it("rejects overlapping files before mutating anything", () => {
    const { p: target } = richProject();
    const clone = M.cloneProject(target); // same ids — a duplicate file
    const floorsBefore = target.floors.length;
    const linksBefore = target.interFloorEdges.length;
    expect(() => mergeProjectInto(target, clone)).toThrow(/already in this project/);
    expect(target.floors).toHaveLength(floorsBefore);
    expect(target.interFloorEdges).toHaveLength(linksBefore);
  });
});
