import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildExport } from "./export";
import { parseProjectFileText, validateProject } from "./persist";

/** JSON round-trip, like reading a saved file. */
const reparse = (p: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(p));

describe("validateProject", () => {
  it("backfills fields added since the file was saved and strips the old type list", () => {
    const raw = reparse(M.newProject());
    delete raw.buildingId;
    delete raw.idPrefix;
    raw.poiTypes = ["door", "custom"];
    const p = validateProject(raw);
    expect(p.buildingId).toBe("");
    expect("poiTypes" in p).toBe(false);
    expect(p.idPrefix).toHaveLength(6);
  });

  it("keeps well-formed door spans, access, and building links", () => {
    const src = M.newProject();
    const f = src.floors[0];
    M.addNode(f.walls, { x: 0, y: 0 }, "A");
    M.addNode(f.walls, { x: 10, y: 0 }, "B");
    M.addEdge(f.walls, "A", "B", "door");
    f.pois.ok = {
      id: "ok",
      x: 5,
      y: 0,
      type: "door",
      span: ["A", "B"],
      access: "emergency_only",
      externalLink: { building: "lib", key: "k", kind: "bridge" },
    };
    const p = validateProject(reparse(src));
    expect(p.floors[0].pois.ok).toEqual(src.floors[0].pois.ok);
  });

  it("drops malformed spans, access values, and links instead of failing the load", () => {
    const src = M.newProject();
    const f = src.floors[0];
    M.addNode(f.walls, { x: 0, y: 0 }, "A");
    M.addNode(f.walls, { x: 10, y: 0 }, "B");
    M.addEdge(f.walls, "A", "B");
    f.pois.bad = { id: "bad", x: 5, y: 0, type: "door", name: "Keep me" };
    const raw = reparse(src) as { floors: Array<{ pois: Record<string, Record<string, unknown>> }> };
    Object.assign(raw.floors[0].pois.bad, {
      span: ["A", "ghost"],
      access: "vip",
      externalLink: { building: 3 },
    });
    const p = validateProject(raw);
    const poi = p.floors[0].pois.bad;
    expect(poi.name).toBe("Keep me");
    expect(poi.span).toBeUndefined();
    expect(poi.access).toBeUndefined();
    expect(poi.externalLink).toBeUndefined();
  });

  it("rejects unusable files", () => {
    expect(() => validateProject(null)).toThrow();
    expect(() => validateProject({ version: 2, floors: [{ id: "f" }] })).toThrow(/version/);
    expect(() => validateProject({ version: 1, floors: [] })).toThrow(/no floors/);
  });
});

describe("parseProjectFileText", () => {
  it("dispatches project files vs exported map JSON", () => {
    const src = M.newProject();
    src.buildingId = "sci";
    const asProject = parseProjectFileText(JSON.stringify(src));
    expect(asProject.kind).toBe("project");
    expect(asProject.project.buildingId).toBe("sci");

    const asMap = parseProjectFileText(JSON.stringify(buildExport(src).json));
    expect(asMap.kind).toBe("map");
    expect(asMap.project.buildingId).toBe("sci");
    expect(asMap.project.floors[0].id).toBe(src.floors[0].id);
  });
});
