// Interchange: rebuild an editable Project from exported map JSON (recovery —
// the export carries everything except plan images), and merge another
// project's floors into the current one (multi-person / add-a-floor workflow).
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
  type Floor,
  type LinkKind,
  type NodeId,
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

    // POIs verbatim (type/name/roomId/navNodeId all survive the export).
    for (const poi of Array.isArray(sf.pois) ? sf.pois : []) {
      if (!poi || typeof poi.id !== "string" || !isNum(poi.x) || !isNum(poi.y)) continue;
      floor.pois[poi.id] = {
        id: poi.id,
        x: poi.x,
        y: poi.y,
        type: typeof poi.type === "string" && poi.type ? poi.type : "poi",
        ...(poi.name ? { name: poi.name } : {}),
        ...(poi.roomId ? { roomId: poi.roomId } : {}),
        ...(poi.navNodeId ? { navNodeId: poi.navNodeId } : {}),
      };
    }

    // Rooms: match polygon vertices back to the welded wall nodes.
    for (const r of Array.isArray(sf.rooms) ? sf.rooms : []) {
      if (!r || typeof r.id !== "string" || !Array.isArray(r.polygon)) continue;
      const loop: NodeId[] = [];
      let ok = true;
      for (const pt of r.polygon) {
        const id = isPair(pt) ? nodeAt.get(coordKey(pt[0], pt[1])) : undefined;
        if (!id) {
          ok = false;
          break;
        }
        loop.push(id);
      }
      if (ok && loop.length >= 3) {
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
      const loop: NodeId[] = [];
      let ok = true;
      for (const pt of sf.outline) {
        const id = isPair(pt) ? nodeAt.get(coordKey(pt[0], pt[1])) : undefined;
        if (!id) {
          ok = false;
          break;
        }
        loop.push(id);
      }
      if (ok) floor.outline = loop;
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

  for (const f of p.floors) {
    for (const poi of Object.values(f.pois)) {
      if (poi.type && !p.poiTypes.includes(poi.type)) p.poiTypes.push(poi.type);
    }
  }

  return { project: p, warnings };
}

/** Appends every floor of `source` (with its POIs, rooms, images, and internal
 *  inter-floor links) into `target`, plus a poiTypes union. Validates BEFORE
 *  mutating, so a thrown collision leaves `target` untouched — safe inside a
 *  docStore.transact. Distinct projects can't collide thanks to id prefixes;
 *  a collision means the file overlaps what's already loaded. */
export function mergeProjectInto(target: Project, source: Project): void {
  for (const f of source.floors) {
    if (target.floors.some((t) => t.id === f.id)) {
      throw new Error(`floor "${f.name}" (${f.id}) is already in this project — same file twice?`);
    }
  }
  const targetNavIds = new Set(target.floors.flatMap((f) => Object.keys(f.nav.nodes)));
  for (const f of source.floors) {
    for (const id of Object.keys(f.nav.nodes)) {
      if (targetNavIds.has(id)) {
        throw new Error(`nav node id ${id} exists in both files — they overlap`);
      }
    }
  }
  target.floors.push(...(source.floors as Floor[]));
  target.interFloorEdges.push(...source.interFloorEdges);
  for (const t of source.poiTypes) {
    if (!target.poiTypes.includes(t)) target.poiTypes.push(t);
  }
}
