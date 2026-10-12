// Export: Project → the clean output JSON consumed by the navigation app,
// plus non-blocking validation warnings. Pure — easy to unit test.
import {
  degree,
  edgeKey,
  loopEdgesValid,
  pathEdgesValid,
  type Floor,
  type Project,
} from "./model";
import { dist, polygonSignedArea } from "./geometry";
import { isPoiType } from "./vocab";

export interface ExportFloor {
  id: string;
  name: string;
  pxPerMeter: number | null;
  width: number | null;
  height: number | null;
  walls: Array<{ start: [number, number]; end: [number, number]; kind?: string }>;
  nav: {
    nodes: Array<{ id: string; x: number; y: number }>;
    edges: Array<{ from: string; to: string; kind?: string }>;
  };
  pois: Array<{
    id: string;
    x: number;
    y: number;
    type: string;
    name?: string;
    roomId?: string;
    navNodeId?: string;
    /** Door extent along its wall (>= 2 points, image px); absent for point POIs. */
    line?: Array<[number, number]>;
    /** Door access restriction ("emergency_only"); absent = normal door. */
    access?: string;
    /** This POI connects to another building — see `externalLinks` and README. */
    externalLink?: { building: string; key: string; kind?: string };
  }>;
  rooms: Array<{
    id: string;
    name: string;
    /** Mirrors the room-POI's type ("room" unless changed, e.g. "stairs"). */
    type: string;
    polygon: Array<[number, number]>;
    poiId: string;
  }>;
  /** Building footprint polygon for zoomed-out map rendering; null if not set. */
  outline: Array<[number, number]> | null;
}

export interface ExternalLinkEntry {
  floor: string;
  poi: string;
  navNode: string;
  building: string; // the other building's buildingId
  key: string;
  kind: string;
}

export interface ExportJson {
  /** Bumped when the shape changes; files without it are version 1. */
  schemaVersion: 2;
  building: string;
  /** Stable slug; the linker matches other maps' externalLink.building to it. */
  buildingId: string;
  floors: ExportFloor[];
  interFloorEdges: Array<{
    from: [string, string];
    to: [string, string];
    kind: string;
    oneWay: boolean;
  }>;
  /** Every POI that connects to another building AND has a nav node (the linker
   *  joins nav nodes). Derived from pois[].externalLink — a convenience index. */
  externalLinks: ExternalLinkEntry[];
}

export interface ExportWarning {
  level: "warn" | "info";
  message: string;
}

export interface ExportResult {
  json: ExportJson;
  warnings: ExportWarning[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

interface Ctx {
  warn: (m: string) => void;
  info: (m: string) => void;
  /** Every externalLink seen, with or without a nav node (for duplicate checks). */
  external: Array<ExternalLinkEntry & { navNode: string | ""; label: string }>;
}

export function buildExport(p: Project): ExportResult {
  const warnings: ExportWarning[] = [];
  const ctx: Ctx = {
    warn: (message) => warnings.push({ level: "warn", message }),
    info: (message) => warnings.push({ level: "info", message }),
    external: [],
  };

  const floors: ExportFloor[] = p.floors.map((f) => exportFloor(f, ctx));

  // Inter-floor edges: keep only those whose endpoints still exist.
  const interFloorEdges: ExportJson["interFloorEdges"] = [];
  for (const e of p.interFloorEdges) {
    const ff = p.floors.find((fl) => fl.id === e.from.floor);
    const tf = p.floors.find((fl) => fl.id === e.to.floor);
    if (!ff || !tf || !ff.nav.nodes[e.from.node] || !tf.nav.nodes[e.to.node]) {
      ctx.warn(`Inter-floor ${e.kind} link references a missing floor/node — dropped from export`);
      continue;
    }
    interFloorEdges.push({
      from: [e.from.floor, e.from.node],
      to: [e.to.floor, e.to.node],
      kind: e.kind,
      oneWay: e.oneWay,
    });
  }

  // Cross-building links: the linker needs a building id on this side and
  // unique (building, key) pairs; a link to our own building is a mistake.
  if (ctx.external.length && !p.buildingId) {
    ctx.warn("No building id set (toolbar, next to the name) — the linker can't reference this map");
  } else if (!p.buildingId) {
    ctx.info("No building id set (toolbar, next to the name)");
  }
  const seen = new Map<string, string>();
  for (const l of ctx.external) {
    if (p.buildingId && l.building === p.buildingId) {
      ctx.warn(`${l.label} links to this same building — use an inter-floor link instead`);
    }
    const k = `${l.building}|${l.key}`;
    const prev = seen.get(k);
    if (prev) {
      ctx.warn(
        `${prev} and ${l.label} both link to "${l.building}" with key "${l.key}" — keys must be unique per building pair`,
      );
    } else {
      seen.set(k, l.label);
    }
  }
  const externalLinks: ExternalLinkEntry[] = ctx.external
    .filter((l) => l.navNode)
    .map(({ floor, poi, navNode, building, key, kind }) => ({ floor, poi, navNode, building, key, kind }));

  checkConnectivity(p, interFloorEdges, warnings);

  return {
    json: {
      schemaVersion: 2,
      building: p.building,
      buildingId: p.buildingId,
      floors,
      interFloorEdges,
      externalLinks,
    },
    warnings,
  };
}

function exportFloor(f: Floor, ctx: Ctx): ExportFloor {
  const { warn, info } = ctx;
  const walls: ExportFloor["walls"] = [];
  for (const e of Object.values(f.walls.edges)) {
    const A = f.walls.nodes[e.a];
    const B = f.walls.nodes[e.b];
    if (!A || !B) continue;
    if (dist(A, B) < 0.01) {
      warn(`${f.name}: zero-length wall segment skipped`);
      continue;
    }
    walls.push({
      start: [r2(A.x), r2(A.y)],
      end: [r2(B.x), r2(B.y)],
      ...(e.kind ? { kind: e.kind } : {}),
    });
  }

  const navNodes = Object.values(f.nav.nodes).map((n) => ({
    id: n.id,
    x: r2(n.x),
    y: r2(n.y),
  }));
  const navEdges: ExportFloor["nav"]["edges"] = [];
  for (const e of Object.values(f.nav.edges)) {
    const A = f.nav.nodes[e.a];
    const B = f.nav.nodes[e.b];
    if (!A || !B) continue;
    if (dist(A, B) < 0.01) {
      warn(`${f.name}: zero-length nav edge skipped`);
      continue;
    }
    navEdges.push({ from: e.a, to: e.b, ...(e.kind ? { kind: e.kind } : {}) });
  }

  const pois: ExportFloor["pois"] = [];
  const spannedEdges = new Set<string>();
  for (const poi of Object.values(f.pois)) {
    const label = `POI "${poi.name ?? poi.id}"`;
    if (!poi.type.trim()) warn(`${f.name}: POI ${poi.id} has an empty type`);
    else if (!isPoiType(poi.type)) {
      warn(`${f.name}: ${label} has type "${poi.type}", which is not in the org list`);
    }
    let navNodeId = poi.navNodeId;
    if (navNodeId && !f.nav.nodes[navNodeId]) {
      warn(`${f.name}: ${label} pointed at a missing nav node — link dropped`);
      navNodeId = undefined;
    }
    let roomId = poi.roomId;
    if (roomId && !f.rooms[roomId]) {
      warn(`${f.name}: ${label} pointed at a missing room — link dropped`);
      roomId = undefined;
    }

    // Door extent. x/y are exported as stored (the span midpoint, maintained by
    // the model) — recomputing + rounding here would break the import round-trip.
    let line: ExportFloor["pois"][number]["line"];
    if (poi.span) {
      if (pathEdgesValid(f, poi.span)) {
        line = poi.span.map((id) => {
          const n = f.walls.nodes[id];
          return [r2(n.x), r2(n.y)] as [number, number];
        });
        let untagged = false;
        for (let i = 0; i + 1 < poi.span.length; i++) {
          const k = edgeKey(poi.span[i], poi.span[i + 1]);
          spannedEdges.add(k);
          if (f.walls.edges[k].kind !== "door") untagged = true;
        }
        if (untagged) info(`${f.name}: door ${label} spans a wall edge not tagged "door"`);
      } else {
        warn(`${f.name}: door ${label} lost its wall span — redraw it with the Door tool (D)`);
      }
    } else if (poi.type === "door") {
      warn(`${f.name}: door ${label} is a point — redraw it with the Door tool (D) to give it an extent`);
    }

    const ext = poi.externalLink;
    if (ext) {
      ctx.external.push({
        floor: f.id,
        poi: poi.id,
        navNode: navNodeId ?? "",
        building: ext.building,
        key: ext.key,
        kind: ext.kind || "door",
        label: `${f.name}: ${label}`,
      });
      if (!ext.building || !ext.key) {
        warn(`${f.name}: ${label} has an incomplete building link — both the building id and the key are required`);
      } else if (!navNodeId) {
        warn(
          `${f.name}: ${label} links to building "${ext.building}" but has no nav node — the linker can't connect it`,
        );
      }
    }

    pois.push({
      id: poi.id,
      x: r2(poi.x),
      y: r2(poi.y),
      type: poi.type,
      ...(poi.name ? { name: poi.name } : {}),
      ...(roomId ? { roomId } : {}),
      ...(navNodeId ? { navNodeId } : {}),
      ...(line ? { line } : {}),
      ...(poi.access ? { access: poi.access } : {}),
      ...(ext
        ? { externalLink: { building: ext.building, key: ext.key, ...(ext.kind ? { kind: ext.kind } : {}) } }
        : {}),
    });
  }
  let doorEdgesWithoutPoi = 0;
  for (const [k, e] of Object.entries(f.walls.edges)) {
    if (e.kind === "door" && !spannedEdges.has(k)) doorEdgesWithoutPoi++;
  }
  if (doorEdgesWithoutPoi) {
    info(
      `${f.name}: ${doorEdgesWithoutPoi} door edge${doorEdgesWithoutPoi === 1 ? "" : "s"} without a door POI (Door tool, or Edge inspector → Add door POI)`,
    );
  }

  const rooms: ExportFloor["rooms"] = [];
  for (const r of Object.values(f.rooms)) {
    if (!loopEdgesValid(f, r.loop)) {
      warn(`${f.name}: room "${r.name}" has a broken boundary — skipped`);
      continue;
    }
    rooms.push({
      id: r.id,
      name: r.name,
      type: f.pois[r.poiId]?.type ?? "room",
      polygon: r.loop.map((id) => {
        const n = f.walls.nodes[id];
        return [r2(n.x), r2(n.y)] as [number, number];
      }),
      poiId: r.poiId,
    });
  }

  let outline: ExportFloor["outline"] = null;
  if (f.outline) {
    // Outline corners just need to exist — they need not be joined by wall edges.
    if (f.outline.length >= 3 && f.outline.every((id) => f.walls.nodes[id])) {
      // Normalize winding to match room polygons, whatever order was clicked.
      const ids =
        polygonSignedArea(f.outline.map((id) => f.walls.nodes[id])) < 0
          ? [...f.outline].reverse()
          : f.outline;
      outline = ids.map((id) => {
        const n = f.walls.nodes[id];
        return [r2(n.x), r2(n.y)] as [number, number];
      });
    } else {
      warn(`${f.name}: building outline is broken — redraw it (Outline tool, O)`);
    }
  }
  if (!outline) info(`${f.name}: no building outline set (Outline tool — O)`);

  if (!f.image) info(`${f.name}: no floor plan image`);
  if (f.pxPerMeter == null) info(`${f.name}: not calibrated (no pxPerMeter)`);
  if (navNodes.length === 0) info(`${f.name}: empty nav graph`);

  return {
    id: f.id,
    name: f.name,
    pxPerMeter: f.pxPerMeter,
    // expectedImageSize keeps extents alive across an export→import round-trip
    // of a recovered project whose images haven't been re-attached yet
    width: f.image?.width ?? f.expectedImageSize?.width ?? null,
    height: f.image?.height ?? f.expectedImageSize?.height ?? null,
    walls,
    nav: { nodes: navNodes, edges: navEdges },
    pois,
    rooms,
    outline,
  };
}

/** Weakly-connected components over the building-wide nav graph (floor edges +
 *  valid inter-floor links; direction ignored for component counting). */
function checkConnectivity(
  p: Project,
  links: ExportJson["interFloorEdges"],
  warnings: ExportWarning[],
): void {
  const key = (floorId: string, nodeId: string) => `${floorId}:${nodeId}`;
  const adj = new Map<string, string[]>();
  const label = new Map<string, string>();

  for (const f of p.floors) {
    for (const n of Object.values(f.nav.nodes)) {
      const k = key(f.id, n.id);
      adj.set(k, []);
      label.set(k, `${n.id} on ${f.name}`);
    }
    for (const e of Object.values(f.nav.edges)) {
      const ka = key(f.id, e.a);
      const kb = key(f.id, e.b);
      if (adj.has(ka) && adj.has(kb)) {
        adj.get(ka)!.push(kb);
        adj.get(kb)!.push(ka);
      }
    }
    // orphan nav nodes (no in-floor edges and no inter-floor links)
    for (const n of Object.values(f.nav.nodes)) {
      const hasLink = links.some(
        (l) =>
          (l.from[0] === f.id && l.from[1] === n.id) || (l.to[0] === f.id && l.to[1] === n.id),
      );
      if (!hasLink && degree(f.nav, n.id) === 0) {
        warnings.push({
          level: "warn",
          message: `Orphan nav node ${n.id} on ${f.name} (no edges)`,
        });
      }
    }
  }
  for (const l of links) {
    const ka = key(l.from[0], l.from[1]);
    const kb = key(l.to[0], l.to[1]);
    if (adj.has(ka) && adj.has(kb)) {
      adj.get(ka)!.push(kb);
      adj.get(kb)!.push(ka);
    }
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.pop()!;
      comp.push(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    components.push(comp);
  }
  if (components.length > 1) {
    components.sort((a, b) => b.length - a.length);
    const desc = components
      .map((c) => `${c.length} node${c.length === 1 ? "" : "s"} (e.g. ${label.get(c[0])})`)
      .join("; ");
    warnings.push({
      level: "warn",
      message: `Nav network is split into ${components.length} disconnected parts: ${desc}`,
    });
  }
}
