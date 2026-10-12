// Interchange: rebuild an editable Project from exported map JSON (recovery —
// the export carries everything except plan images), and merge another
// project's floors into the current one (multi-person workflow: each person
// traces their floor in a fork of the lead's shared file; the integrator merges
// each fork back, replacing floors by id).
//
// Reconstruction notes: exported walls are flat segments with no node identity,
// so endpoints are welded back into shared nodes by their (rounded) coordinates
// — exports round to 0.01px, so coincident endpoints match exactly. Nav node
// ids ARE preserved by the export and are kept verbatim (inter-floor links and
// poi.navNodeId depend on them); the rebuilt project gets a fresh idPrefix, so
// newly minted wall-node ids can never collide with the preserved ones.
import {
  addEdge,
  addNode,
  newFloor,
  newId,
  newProject,
  pathEdgesValid,
  sameLink,
  type Floor,
  type FloorId,
  type InterFloorEdge,
  type LinkKind,
  type NodeId,
  type Poi,
  type Project,
} from "./model";
import type { ExportJson } from "./export";

export interface MapImportResult {
  project: Project;
  warnings: string[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

const coordKey = (x: number, y: number): string => `${x.toFixed(2)}|${y.toFixed(2)}`;

export function importMapJson(obj: unknown): MapImportResult {
  const src = obj as ExportJson;
  if (!src || typeof src !== "object" || !Array.isArray(src.floors)) {
    throw new Error("Not an exported map file (no floors array)");
  }
  const warnings: string[] = [];
  const p = newProject();
  p.floors = []; // drop the seed floor
  if (typeof src.building === "string" && src.building) p.building = src.building;
  if (typeof src.buildingId === "string") p.buildingId = src.buildingId;

  for (const sf of src.floors) {
    if (!sf || typeof sf !== "object") continue;
    const floor = newFloor(p, typeof sf.name === "string" && sf.name ? sf.name : `Floor ${p.floors.length + 1}`);
    if (typeof sf.id === "string" && sf.id) floor.id = sf.id; // inter-floor links reference it
    floor.pxPerMeter = isNum(sf.pxPerMeter) ? sf.pxPerMeter : null;
    if (isNum(sf.width) && isNum(sf.height)) {
      floor.expectedImageSize = { width: sf.width, height: sf.height };
    }

    // Walls: weld segment endpoints into shared nodes by coordinate.
    const nodeAt = new Map<string, NodeId>();
    const nodeFor = (pt: [number, number]): NodeId => {
      const k = coordKey(pt[0], pt[1]);
      let id = nodeAt.get(k);
      if (!id) {
        id = newId(p, "n");
        addNode(floor.walls, { x: pt[0], y: pt[1] }, id);
        nodeAt.set(k, id);
      }
      return id;
    };
    for (const w of Array.isArray(sf.walls) ? sf.walls : []) {
      if (!w || !isPair(w.start) || !isPair(w.end)) continue;
      if (coordKey(w.start[0], w.start[1]) === coordKey(w.end[0], w.end[1])) continue; // zero-length
      addEdge(
        floor.walls,
        nodeFor(w.start),
        nodeFor(w.end),
        typeof w.kind === "string" && w.kind ? w.kind : undefined,
      );
    }
    /** Matches an exported polyline/polygon back onto welded wall nodes. */
    const matchPoints = (pts: unknown[]): NodeId[] | null => {
      const ids: NodeId[] = [];
      for (const pt of pts) {
        const id = isPair(pt) ? nodeAt.get(coordKey(pt[0], pt[1])) : undefined;
        if (!id) return null;
        ids.push(id);
      }
      return ids;
    };

    // Nav graph: ids preserved verbatim.
    for (const n of sf.nav?.nodes ?? []) {
      if (n && typeof n.id === "string" && isNum(n.x) && isNum(n.y)) {
        addNode(floor.nav, { x: n.x, y: n.y }, n.id);
      }
    }
    for (const e of sf.nav?.edges ?? []) {
      if (e && typeof e.from === "string" && typeof e.to === "string") {
        addEdge(floor.nav, e.from, e.to, typeof e.kind === "string" && e.kind ? e.kind : undefined);
      }
    }

    // POIs verbatim (x/y, type, name, links, access); door spans re-matched
    // onto the welded wall nodes like room polygons are.
    for (const sp of Array.isArray(sf.pois) ? sf.pois : []) {
      if (!sp || typeof sp.id !== "string" || !isNum(sp.x) || !isNum(sp.y)) continue;
      const ext = sp.externalLink;
      const poi: Poi = {
        id: sp.id,
        x: sp.x,
        y: sp.y,
        type: typeof sp.type === "string" && sp.type ? sp.type : "poi",
        ...(sp.name ? { name: sp.name } : {}),
        ...(sp.roomId ? { roomId: sp.roomId } : {}),
        ...(sp.navNodeId ? { navNodeId: sp.navNodeId } : {}),
        ...(sp.access === "emergency_only" ? { access: "emergency_only" as const } : {}),
        ...(ext && typeof ext.building === "string" && typeof ext.key === "string"
          ? {
              externalLink: {
                building: ext.building,
                key: ext.key,
                ...(typeof ext.kind === "string" && ext.kind ? { kind: ext.kind } : {}),
              },
            }
          : {}),
      };
      if (Array.isArray(sp.line) && sp.line.length >= 2) {
        const span = matchPoints(sp.line);
        if (span && pathEdgesValid(floor, span)) poi.span = span;
        else {
          warnings.push(
            `${floor.name}: door "${poi.name ?? poi.id}" didn't match the wall segments — redraw it with the Door tool (D)`,
          );
        }
      }
      floor.pois[poi.id] = poi;
    }

    // Rooms: match polygon vertices back to the welded wall nodes.
    for (const r of Array.isArray(sf.rooms) ? sf.rooms : []) {
      if (!r || typeof r.id !== "string" || !Array.isArray(r.polygon)) continue;
      const loop = matchPoints(r.polygon);
      if (loop && loop.length >= 3) {
        floor.rooms[r.id] = {
          id: r.id,
          name: typeof r.name === "string" && r.name ? r.name : "Room",
          loop,
          poiId: r.poiId,
        };
      } else {
        warnings.push(
          `${floor.name}: room "${r.name ?? r.id}" didn't match the wall corners — recreate it with the Room tool`,
        );
        const poi = typeof r.poiId === "string" ? floor.pois[r.poiId] : undefined;
        if (poi) delete poi.roomId; // keep the paired lifecycle consistent
      }
    }

    // Outline: same vertex matching; direction is irrelevant.
    if (Array.isArray(sf.outline) && sf.outline.length >= 3) {
      const loop = matchPoints(sf.outline);
      if (loop) floor.outline = loop;
      else warnings.push(`${floor.name}: outline didn't match the wall corners — redraw it (O)`);
    }

    p.floors.push(floor);
  }
  if (!p.floors.length) p.floors.push(newFloor(p, "Floor 1"));

  for (const l of Array.isArray(src.interFloorEdges) ? src.interFloorEdges : []) {
    const from = l?.from;
    const to = l?.to;
    const ff = Array.isArray(from) ? p.floors.find((f) => f.id === from[0]) : undefined;
    const tf = Array.isArray(to) ? p.floors.find((f) => f.id === to[0]) : undefined;
    if (ff && tf && ff.nav.nodes[from[1]] && tf.nav.nodes[to[1]]) {
      const kind: LinkKind = l.kind === "elevator" || l.kind === "escalator" ? l.kind : "stairs";
      p.interFloorEdges.push({
        from: { floor: from[0], node: from[1] },
        to: { floor: to[0], node: to[1] },
        kind,
        oneWay: !!l.oneWay,
      });
    } else {
      warnings.push(`Dropped an inter-floor ${l?.kind ?? "stairs"} link with missing endpoints`);
    }
  }
  // Top-level externalLinks is a derived index — the per-POI field is the source of truth.

  return { project: p, warnings };
}

// ---------------------------------------------------------------------------
// Merge: bring another file's floors into this project
// ---------------------------------------------------------------------------

export interface FloorStats {
  walls: number;
  nav: number;
  pois: number;
  rooms: number;
  image: boolean;
}

export function floorStats(f: Floor): FloorStats {
  return {
    walls: Object.keys(f.walls.edges).length,
    nav: Object.keys(f.nav.nodes).length,
    pois: Object.keys(f.pois).length,
    rooms: Object.keys(f.rooms).length,
    image: !!f.image,
  };
}

export const floorHasContent = (s: FloorStats): boolean => s.walls + s.nav + s.pois + s.rooms > 0;

export interface MergeRow {
  id: FloorId;
  name: string;
  /** `replace`: a floor with this id is already in the target (same lineage —
   *  typically a fork of the lead's shared file) and would be overwritten. */
  status: "new" | "replace";
  targetName?: string;
  src: FloorStats;
  dst?: FloorStats;
  /** New floors, and replacements where the source actually has content. */
  defaultChecked: boolean;
}

/** What `mergeProjectInto` would do, per source floor — for the merge dialog. Pure. */
export function mergePreview(target: Project, source: Project): MergeRow[] {
  return source.floors.map((f) => {
    const existing = target.floors.find((t) => t.id === f.id);
    const src = floorStats(f);
    if (!existing) return { id: f.id, name: f.name, status: "new", src, defaultChecked: true };
    return {
      id: f.id,
      name: f.name,
      status: "replace",
      targetName: existing.name,
      src,
      dst: floorStats(existing),
      defaultChecked: floorHasContent(src),
    };
  });
}

export interface MergeResult {
  added: FloorId[];
  replaced: FloorId[];
  /** Target links that no longer had both endpoints after the replacement. */
  droppedLinks: number;
}

/** Brings the chosen floors of `source` into `target`: a floor whose id already
 *  exists is REPLACED in place (same position in the floor list), others are
 *  appended. Inter-floor links from both sides are kept when both endpoints
 *  still exist afterwards (nav ids are stable, so links to an unchanged stairwell
 *  survive a re-merge) and deduplicated. Validates BEFORE mutating, so a thrown
 *  collision leaves `target` untouched — safe inside a docStore.transact. */
export function mergeProjectInto(
  target: Project,
  source: Project,
  opts: { floorIds: Set<FloorId> },
): MergeResult {
  const chosen = source.floors.filter((f) => opts.floorIds.has(f.id));
  const replacing = new Set(
    chosen.filter((f) => target.floors.some((t) => t.id === f.id)).map((f) => f.id),
  );
  // Ids must be unique across the floors that will coexist afterwards. Distinct
  // sessions can't collide thanks to id prefixes; a collision means overlap.
  const staying = target.floors.filter((t) => !replacing.has(t.id));
  const navIds = new Set(staying.flatMap((f) => Object.keys(f.nav.nodes)));
  const poiIds = new Set(staying.flatMap((f) => Object.keys(f.pois)));
  for (const f of chosen) {
    for (const id of Object.keys(f.nav.nodes)) {
      if (navIds.has(id)) throw new Error(`nav node id ${id} exists in both files — they overlap`);
    }
    for (const id of Object.keys(f.pois)) {
      if (poiIds.has(id)) throw new Error(`POI id ${id} exists in both files — they overlap`);
    }
  }

  const added: FloorId[] = [];
  const replaced: FloorId[] = [];
  for (const f of chosen) {
    const i = target.floors.findIndex((t) => t.id === f.id);
    if (i >= 0) {
      const old = target.floors[i];
      // A map-JSON source has no images: keep the one already attached when it
      // matches the raster the source was traced on.
      const sz = f.expectedImageSize;
      if (!f.image && old.image && (!sz || (sz.width === old.image.width && sz.height === old.image.height))) {
        f.image = old.image;
        delete f.expectedImageSize;
      }
      target.floors[i] = f;
      replaced.push(f.id);
    } else {
      target.floors.push(f);
      added.push(f.id);
    }
  }

  const exists = (ref: { floor: FloorId; node: NodeId }): boolean => {
    const fl = target.floors.find((t) => t.id === ref.floor);
    return !!fl && !!fl.nav.nodes[ref.node];
  };
  const live = (e: InterFloorEdge) => exists(e.from) && exists(e.to);
  const droppedLinks = target.interFloorEdges.filter((e) => !live(e)).length;
  const merged: InterFloorEdge[] = [];
  for (const e of [...target.interFloorEdges, ...source.interFloorEdges]) {
    if (!live(e)) continue;
    if (merged.some((o) => sameLink(o, e))) continue;
    merged.push(e);
  }
  target.interFloorEdges = merged;
  return { added, replaced, droppedLinks };
}
