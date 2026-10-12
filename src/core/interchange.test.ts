import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildExport, type ExportJson } from "./export";
import { importMapJson, mergePreview, mergeProjectInto } from "./interchange";

/** Two floors: wall square with a spanned, emergency-only door linked to another
 *  building + room + linked POI + outline + nav on F1 (with an image), triangle
 *  walls + nav on F2 (no image), one-way escalator between them. Calibrated.
 *  `pre` prefixes the hand-written ids, mimicking per-session id prefixes. */
function richProject(pre = "") {
  const id = (s: string) => pre + s;
  const p = M.newProject();
  p.buildingId = "science-hall";
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
    type: "stairs",
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
  f1.pois[id("pdoor")] = {
    id: id("pdoor"),
    x: 100,
    y: 50,
    type: "door",
    name: "East door",
    span: [id("B"), id("C")],
    access: "emergency_only",
    navNodeId: id("n2"),
    externalLink: { building: "library", key: "bridge-1", kind: "bridge" },
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

    expect(second.schemaVersion).toBe(2);
    expect(second.building).toBe(first.building);
    expect(second.buildingId).toBe(first.buildingId);
    expect(second.interFloorEdges).toEqual(first.interFloorEdges);
    expect(second.externalLinks).toEqual(first.externalLinks);
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
      expect(sortSegs(b.pois)).toEqual(sortSegs(a.pois)); // incl. line/access/externalLink
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

  it("rebuilds door spans onto the welded nodes and keeps access/links", () => {
    const { p } = richProject();
    const { project: rebuilt } = importMapJson(buildExport(p).json);
    const f1 = rebuilt.floors[0];
    const door = f1.pois.pdoor;
    expect(door.span).toHaveLength(2);
    expect(M.pathEdgesValid(f1, door.span!)).toBe(true);
    expect(M.doorPoiForEdge(f1, M.edgeKey(door.span![0], door.span![1]))).toBe(door);
    expect(f1.walls.edges[M.edgeKey(door.span![0], door.span![1])].kind).toBe("door");
    expect(door).toMatchObject({
      x: 100,
      y: 50,
      access: "emergency_only",
      navNodeId: "n2",
      externalLink: { building: "library", key: "bridge-1", kind: "bridge" },
    });
  });

  it("drops an unmatchable door span with a warning but keeps the POI", () => {
    const { p } = richProject();
    const json = buildExport(p).json as ExportJson;
    json.floors[0].pois.find((x) => x.id === "pdoor")!.line![1] = [999, 999];
    const { project: rebuilt, warnings } = importMapJson(json);
    const door = rebuilt.floors[0].pois.pdoor;
    expect(door).toBeDefined();
    expect(door.span).toBeUndefined();
    expect(door.name).toBe("East door");
    expect(warnings.some((w) => w.includes("East door"))).toBe(true);
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
    expect(rebuilt.buildingId).toBe("science-hall");
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

const allIds = (p: M.Project) => new Set(p.floors.map((f) => f.id));

describe("mergeProjectInto", () => {
  it("appends floors and links from a separately created project", () => {
    const target = richProject().p;
    const source = richProject("z-").p; // distinct ids, as session prefixes guarantee
    const before = target.floors.length;
    const rows = mergePreview(target, source);
    expect(rows.map((r) => r.status)).toEqual(["new", "new"]);
    expect(rows.every((r) => r.defaultChecked)).toBe(true);
    const res = mergeProjectInto(target, source, { floorIds: allIds(source) });
    expect(res.added).toHaveLength(2);
    expect(res.replaced).toEqual([]);
    expect(target.floors).toHaveLength(before + 2);
    expect(target.interFloorEdges).toHaveLength(2); // one internal link from each
  });

  it("only brings in the chosen floors", () => {
    const target = richProject().p;
    const source = richProject("z-").p;
    const res = mergeProjectInto(target, source, { floorIds: new Set([source.floors[1].id]) });
    expect(res.added).toEqual([source.floors[1].id]);
    expect(target.floors).toHaveLength(3);
    // the source's internal link pointed at its un-chosen floor → not carried
    expect(target.interFloorEdges).toHaveLength(1);
  });

  /** The template workflow: a lead's file with two named floors, forked by two
   *  people who each trace one floor under their own session prefix. */
  function templateForks() {
    const lead = M.newProject();
    lead.buildingId = "sci";
    lead.floors[0].name = "Ground";
    lead.floors.push(M.newFloor(lead, "First"));
    const [groundId, firstId] = lead.floors.map((f) => f.id);

    const forkA = M.cloneProject(lead);
    forkA.idPrefix = "aaaaaa";
    const ga = forkA.floors[0];
    const a1 = M.newId(forkA, "n");
    const a2 = M.newId(forkA, "n");
    M.addNode(ga.walls, { x: 0, y: 0 }, a1);
    M.addNode(ga.walls, { x: 10, y: 0 }, a2);
    M.addEdge(ga.walls, a1, a2);
    const aNav = M.newId(forkA, "n");
    M.addNode(ga.nav, { x: 5, y: 5 }, aNav);
    ga.image = { dataUrl: "data:,g", width: 500, height: 400 };

    const forkB = M.cloneProject(lead);
    forkB.idPrefix = "bbbbbb";
    const fb = forkB.floors[1];
    const b1 = M.newId(forkB, "n");
    const b2 = M.newId(forkB, "n");
    M.addNode(fb.nav, { x: 1, y: 1 }, b1);
    M.addNode(fb.nav, { x: 9, y: 1 }, b2);
    M.addEdge(fb.nav, b1, b2);
    const bPoi = M.newId(forkB, "p");
    fb.pois[bPoi] = { id: bPoi, x: 1, y: 1, type: "printer" };
    expect(a1.startsWith("aaaaaa-")).toBe(true);
    expect(bPoi.startsWith("bbbbbb-")).toBe(true);
    return { forkA, forkB, groundId, firstId, aNav, b1, b2, bPoi };
  }

  it("replaces same-id floors in place and leaves untouched ones alone by default", () => {
    const { forkA, forkB, groundId, firstId, bPoi } = templateForks();
    const rows = mergePreview(forkA, forkB);
    expect(rows).toMatchObject([
      { id: groundId, status: "replace", targetName: "Ground", defaultChecked: false }, // B never touched it
      { id: firstId, status: "replace", targetName: "First", defaultChecked: true },
    ]);
    const res = mergeProjectInto(forkA, forkB, {
      floorIds: new Set(rows.filter((r) => r.defaultChecked).map((r) => r.id)),
    });
    expect(res).toEqual({ added: [], replaced: [firstId], droppedLinks: 0 });
    expect(forkA.floors.map((f) => f.id)).toEqual([groundId, firstId]); // same order
    expect(Object.keys(forkA.floors[0].walls.edges)).toHaveLength(1); // A's work intact
    expect(forkA.floors[1].pois[bPoi]).toBeDefined(); // B's work landed
  });

  it("keeps inter-floor links whose nodes survive a replacement and drops the rest", () => {
    const { forkA, forkB, groundId, firstId, aNav, b1, b2 } = templateForks();
    // The integrator linked Ground ↔ First using B's first version…
    mergeProjectInto(forkA, forkB, { floorIds: new Set([firstId]) });
    forkA.interFloorEdges.push({
      from: { floor: groundId, node: aNav },
      to: { floor: firstId, node: b1 },
      kind: "stairs",
      oneWay: false,
    });
    // …then B sends a revision that kept b1 (now joined to a new node) but deleted b2.
    const revision = M.cloneProject(forkB);
    const b3 = M.newId(revision, "n");
    M.addNode(revision.floors[1].nav, { x: 5, y: 9 }, b3);
    M.addEdge(revision.floors[1].nav, b1, b3);
    M.deleteNavNode(revision, revision.floors[1], b2);
    expect(revision.floors[1].nav.nodes[b1]).toBeDefined();
    const kept = mergeProjectInto(forkA, revision, { floorIds: new Set([firstId]) });
    expect(kept.droppedLinks).toBe(0);
    expect(forkA.interFloorEdges).toHaveLength(1);
    // A later revision without n1 at all → the link goes.
    const gone = M.cloneProject(forkB);
    M.deleteNavNode(gone, gone.floors[1], b1);
    const res = mergeProjectInto(forkA, gone, { floorIds: new Set([firstId]) });
    expect(res.droppedLinks).toBe(1);
    expect(forkA.interFloorEdges).toHaveLength(0);
  });

  it("dedupes links carried by both sides", () => {
    const target = richProject().p;
    const fork = M.cloneProject(target); // same link inside
    mergeProjectInto(target, fork, { floorIds: allIds(fork) });
    expect(target.interFloorEdges).toHaveLength(1);
  });

  it("carries the attached image onto a replacing floor that has none (map-JSON source)", () => {
    const { forkA, forkB, groundId, firstId } = templateForks();
    const recovered = importMapJson(buildExport(forkA).json).project; // no images, sizes remembered
    const res = mergeProjectInto(forkA, recovered, { floorIds: new Set([groundId, firstId]) });
    expect(res.replaced).toEqual([groundId, firstId]);
    expect(forkA.floors[0].image?.dataUrl).toBe("data:,g");
    expect(forkA.floors[0].expectedImageSize).toBeUndefined();
    void forkB;
  });

  it("rejects overlapping ids in floors that would coexist, before mutating anything", () => {
    const { p: target } = richProject();
    const other = richProject().p; // different floor ids, same hand-written nav ids
    const floorsBefore = target.floors.length;
    const linksBefore = target.interFloorEdges.length;
    expect(() => mergeProjectInto(target, other, { floorIds: allIds(other) })).toThrow(
      /exists in both files/,
    );
    expect(target.floors).toHaveLength(floorsBefore);
    expect(target.interFloorEdges).toHaveLength(linksBefore);
  });
});
