// Document model: types, factories, and all graph/project mutation operations.
// Everything here is plain data + pure-ish functions that mutate in place; they are
// only ever called inside docStore transactions/gestures.
import { dist, segSegIntersection } from "./geometry";

export type NodeId = string;
export type PoiId = string;
export type FloorId = string;
export type RoomId = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface GraphNode {
  id: NodeId;
  x: number;
  y: number;
}

// Undirected edge. `kind` is an open extension point: walls use e.g. "door"
// (and later "window", ...); nav edges can use e.g. "accessible".
export interface GraphEdge {
  a: NodeId;
  b: NodeId;
  kind?: string;
}

export interface Graph {
  nodes: Record<NodeId, GraphNode>;
  // Keyed by canonical edgeKey(a,b) — duplicate and self edges are impossible to store.
  edges: Record<string, GraphEdge>;
}

export interface Poi {
  id: PoiId;
  x: number;
  y: number;
  type: string;
  name?: string;
  roomId?: RoomId; // set on the auto-created POI of a room
  navNodeId?: NodeId; // set when a nav node was created snapped onto this POI
  /** Door extent: ordered wall node ids (>= 2) along one wall; every consecutive
   *  pair must be a wall edge. x/y is kept equal to the midpoint of the first and
   *  last node by syncDoorPois (stored, not derived, so everything that reads
   *  poi.x/y keeps working). Patched on wall split/merge/delete like room loops;
   *  when it stops being a valid path the POI degrades to a plain point. */
  span?: NodeId[];
  /** Door access restriction; undefined = normal. Open enum (see vocab.ts). */
  access?: "emergency_only";
  /** This POI connects to another building; the backend linker joins the two
   *  sides by (building, key). See README "Linking buildings". */
  externalLink?: ExternalLink;
}

export interface ExternalLink {
  building: string; // the OTHER building's buildingId
  key: string; // shared key agreed by both sides; unique per building pair
  kind?: string; // door (default) | bridge | tunnel | path | ...
}

// Boundary loop of wall node ids, in face order (>= 3). The polygon is resolved
// from the wall nodes' current coordinates, so it follows wall edits.
export interface Room {
  id: RoomId;
  name: string;
  loop: NodeId[];
  poiId: PoiId;
}

export interface FloorImage {
  dataUrl: string;
  width: number;
  height: number;
  source?: { fileName: string; page?: number };
}

export interface Floor {
  id: FloorId;
  name: string;
  image: FloorImage | null; // treated as immutable; shared by reference across undo snapshots
  pxPerMeter: number | null;
  walls: Graph;
  nav: Graph;
  pois: Record<PoiId, Poi>;
  rooms: Record<RoomId, Room>;
  /** Building footprint for zoomed-out rendering: an ordered ring of wall node
   *  ids picked with the Outline tool. Corners need NOT be joined by wall edges
   *  (unlike room loops) — the polygon simply connects the picked nodes, so it
   *  follows wall edits and tolerates gaps in the wall graph. Nulled when it
   *  drops below 3 existing nodes. */
  outline: NodeId[] | null;
  /** Set when the project was rebuilt from exported map JSON (which carries no
   *  plan images): the raster size the geometry was traced on, so re-importing
   *  the plan can offer a proportional rescale if the new raster differs.
   *  Treated as immutable; cleared when an image is set. */
  expectedImageSize?: { width: number; height: number };
}

export type LinkKind = "stairs" | "elevator" | "escalator";

export interface InterFloorEdge {
  from: { floor: FloorId; node: NodeId }; // nav node ids
  to: { floor: FloorId; node: NodeId };
  kind: LinkKind;
  oneWay: boolean;
}

export interface Project {
  version: 1;
  building: string; // display name
  /** Stable slug identifying the building across files and exports ("" until
   *  set). The backend linker matches externalLink.building against it. */
  buildingId: string;
  floors: Floor[]; // array order = switcher order
  interFloorEdges: InterFloorEdge[];
  /** Prefix for ids minted in THIS editing session. Re-minted on every file
   *  Open (persist.loadProjectFile), so two people who fork the same shared file
   *  never mint colliding ids; existing ids are never renumbered. */
  idPrefix: string;
  idCounter: number;
}

export const edgeKey = (a: NodeId, b: NodeId): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

/** Normalizes a building id: lowercase, [a-z0-9-], no leading/trailing dashes. */
export function buildingSlug(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function newId(p: Project, prefix: string): string {
  p.idCounter += 1;
  return `${p.idPrefix}-${prefix}${p.idCounter}`;
}

export function emptyGraph(): Graph {
  return { nodes: {}, edges: {} };
}

export function newFloor(p: Project, name: string): Floor {
  return {
    id: newId(p, "f"),
    name,
    image: null,
    pxPerMeter: null,
    walls: emptyGraph(),
    nav: emptyGraph(),
    pois: {},
    rooms: {},
    outline: null,
  };
}

/** 6 base36 chars ≈ 2.2 billion — collisions between sessions are negligible. */
export function mintIdPrefix(len = 6): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function newProject(): Project {
  const p: Project = {
    version: 1,
    building: "Building",
    buildingId: "",
    floors: [],
    interFloorEdges: [],
    idPrefix: mintIdPrefix(),
    idCounter: 0,
  };
  p.floors.push(newFloor(p, "Floor 1"));
  return p;
}

export function findFloor(p: Project, id: FloorId): Floor | undefined {
  return p.floors.find((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// Generic graph operations
// ---------------------------------------------------------------------------

export function addNode(g: Graph, pt: Vec2, id: NodeId): GraphNode {
  const n: GraphNode = { id, x: pt.x, y: pt.y };
  g.nodes[id] = n;
  return n;
}

/** Returns false (and stores nothing) on self-edges, duplicates, or missing endpoints. */
export function addEdge(g: Graph, a: NodeId, b: NodeId, kind?: string): boolean {
  if (a === b || !g.nodes[a] || !g.nodes[b]) return false;
  const k = edgeKey(a, b);
  if (g.edges[k]) return false;
  g.edges[k] = kind ? { a, b, kind } : { a, b };
  return true;
}

export function edgesAt(g: Graph, id: NodeId): string[] {
  const out: string[] = [];
  for (const [k, e] of Object.entries(g.edges)) if (e.a === id || e.b === id) out.push(k);
  return out;
}

export function degree(g: Graph, id: NodeId): number {
  return edgesAt(g, id).length;
}

/** Removes any of the given nodes that now have degree 0. Returns the removed ids. */
export function orphanSweep(g: Graph, ids: NodeId[]): NodeId[] {
  const removed: NodeId[] = [];
  for (const id of ids) {
    if (g.nodes[id] && degree(g, id) === 0) {
      delete g.nodes[id];
      removed.push(id);
    }
  }
  return removed;
}

/** Deletes an edge and sweeps newly-orphaned endpoints. Returns swept node ids. */
export function deleteEdgeRaw(g: Graph, key: string): NodeId[] {
  const e = g.edges[key];
  if (!e) return [];
  delete g.edges[key];
  return orphanSweep(g, [e.a, e.b]);
}

/** Replaces the edge with (a—new, new—b), preserving kind. */
export function splitEdge(g: Graph, key: string, at: Vec2, id: NodeId): GraphNode | null {
  const e = g.edges[key];
  if (!e) return null;
  delete g.edges[key];
  const n = addNode(g, at, id);
  addEdge(g, e.a, id, e.kind);
  addEdge(g, id, e.b, e.kind);
  return n;
}

/** Rewires drop's edges onto keep; canonical keys collapse duplicates/self-edges. */
export function mergeNodes(g: Graph, keep: NodeId, drop: NodeId): void {
  if (keep === drop || !g.nodes[keep] || !g.nodes[drop]) return;
  for (const k of edgesAt(g, drop)) {
    const e = g.edges[k];
    delete g.edges[k];
    const other = e.a === drop ? e.b : e.a;
    if (other !== keep) addEdge(g, keep, other, e.kind);
  }
  delete g.nodes[drop];
}

/** Deletes the node, its incident edges, and any neighbors that become degree-0.
 *  Returns every removed node id (including `id`). */
export function deleteNodeCascade(g: Graph, id: NodeId): NodeId[] {
  if (!g.nodes[id]) return [];
  const neighbors: NodeId[] = [];
  for (const k of edgesAt(g, id)) {
    const e = g.edges[k];
    neighbors.push(e.a === id ? e.b : e.a);
    delete g.edges[k];
  }
  delete g.nodes[id];
  return [id, ...orphanSweep(g, neighbors)];
}

// ---------------------------------------------------------------------------
// Walls-layer wrappers (ripple into rooms)
// ---------------------------------------------------------------------------

export function loopEdgesValid(floor: Floor, loop: NodeId[]): boolean {
  if (loop.length < 3) return false;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (!floor.walls.nodes[a] || !floor.walls.nodes[b]) return false;
    if (!floor.walls.edges[edgeKey(a, b)]) return false;
  }
  return true;
}

export function deleteRoom(floor: Floor, roomId: RoomId): void {
  const r = floor.rooms[roomId];
  if (!r) return;
  delete floor.rooms[roomId];
  const poi = floor.pois[r.poiId];
  if (poi && poi.roomId === roomId) delete floor.pois[r.poiId];
}

/** Deletes rooms whose loops are no longer valid closed boundaries. Returns their ids. */
export function sweepRooms(floor: Floor): RoomId[] {
  const dead: RoomId[] = [];
  for (const r of Object.values(floor.rooms)) if (!loopEdgesValid(floor, r.loop)) dead.push(r.id);
  for (const id of dead) deleteRoom(floor, id);
  return dead;
}

/** Outline validity is looser than rooms': just >= 3 existing wall nodes. */
function sweepOutline(floor: Floor): void {
  if (!floor.outline) return;
  if (floor.outline.length < 3 || floor.outline.some((id) => !floor.walls.nodes[id])) {
    floor.outline = null;
  }
}

function dedupeLoop(loop: NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  for (const id of loop) if (out[out.length - 1] !== id) out.push(id);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

function patchLoopOnSplit(loop: NodeId[], a: NodeId, b: NodeId, id: NodeId): void {
  for (let i = 0; i < loop.length; i++) {
    const u = loop[i];
    const v = loop[(i + 1) % loop.length];
    if ((u === a && v === b) || (u === b && v === a)) {
      loop.splice(i + 1, 0, id);
      return;
    }
  }
}

// --- door spans (open paths along a wall) ---------------------------------

/** Open-path analogue of loopEdgesValid: >= 2 distinct existing wall nodes with
 *  every consecutive pair joined by a wall edge. */
export function pathEdgesValid(floor: Floor, path: NodeId[]): boolean {
  if (path.length < 2) return false;
  if (new Set(path).size !== path.length) return false;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!floor.walls.nodes[a] || !floor.walls.nodes[b]) return false;
    if (!floor.walls.edges[edgeKey(a, b)]) return false;
  }
  return true;
}

/** Consecutive-duplicate removal for open paths. Unlike dedupeLoop it never
 *  collapses first/last — a path is not a cycle; a folded [a,b,a] stays invalid. */
function dedupePath(path: NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  for (const id of path) if (out[out.length - 1] !== id) out.push(id);
  return out;
}

/** No wrap-around pair, unlike patchLoopOnSplit. */
function patchPathOnSplit(path: NodeId[], a: NodeId, b: NodeId, id: NodeId): void {
  for (let i = 0; i + 1 < path.length; i++) {
    const u = path[i];
    const v = path[i + 1];
    if ((u === a && v === b) || (u === b && v === a)) {
      path.splice(i + 1, 0, id);
      return;
    }
  }
}

/** Keeps door POIs consistent with the wall graph. A span that is no longer a
 *  valid wall path is dropped — the POI survives as a plain point at its last
 *  position (never deleted, so a wall edit can't lose names/links); valid spans
 *  re-center x/y on the midpoint of their end nodes. Returns the ids that lost
 *  their span. Called by every wall wrapper below. */
export function syncDoorPois(floor: Floor): PoiId[] {
  const degraded: PoiId[] = [];
  for (const poi of Object.values(floor.pois)) {
    if (!poi.span) continue;
    if (!pathEdgesValid(floor, poi.span)) {
      delete poi.span;
      degraded.push(poi.id);
      continue;
    }
    const a = floor.walls.nodes[poi.span[0]];
    const b = floor.walls.nodes[poi.span[poi.span.length - 1]];
    poi.x = (a.x + b.x) / 2;
    poi.y = (a.y + b.y) / 2;
  }
  return degraded;
}

/** The door POI whose span runs along this wall edge, if any. */
export function doorPoiForEdge(floor: Floor, key: string): Poi | undefined {
  for (const poi of Object.values(floor.pois)) {
    const s = poi.span;
    if (!s) continue;
    for (let i = 0; i + 1 < s.length; i++) if (edgeKey(s[i], s[i + 1]) === key) return poi;
  }
  return undefined;
}

export function splitWallEdge(floor: Floor, key: string, at: Vec2, id: NodeId): GraphNode | null {
  const e = floor.walls.edges[key];
  if (!e) return null;
  const { a, b } = e;
  const n = splitEdge(floor.walls, key, at, id);
  if (!n) return null;
  for (const r of Object.values(floor.rooms)) patchLoopOnSplit(r.loop, a, b, id);
  if (floor.outline) patchLoopOnSplit(floor.outline, a, b, id);
  for (const poi of Object.values(floor.pois)) {
    if (poi.span) patchPathOnSplit(poi.span, a, b, id);
  }
  syncDoorPois(floor);
  return n;
}

export function mergeWallNodes(floor: Floor, keep: NodeId, drop: NodeId): void {
  mergeNodes(floor.walls, keep, drop);
  for (const r of Object.values(floor.rooms)) {
    r.loop = dedupeLoop(r.loop.map((x) => (x === drop ? keep : x)));
  }
  if (floor.outline) {
    floor.outline = dedupeLoop(floor.outline.map((x) => (x === drop ? keep : x)));
  }
  for (const poi of Object.values(floor.pois)) {
    if (poi.span) poi.span = dedupePath(poi.span.map((x) => (x === drop ? keep : x)));
  }
  sweepRooms(floor);
  sweepOutline(floor);
  syncDoorPois(floor);
}

export function deleteWallNode(floor: Floor, id: NodeId): void {
  const removed = new Set(deleteNodeCascade(floor.walls, id));
  for (const r of Object.values(floor.rooms)) {
    r.loop = dedupeLoop(r.loop.filter((x) => !removed.has(x)));
  }
  if (floor.outline) {
    floor.outline = dedupeLoop(floor.outline.filter((x) => !removed.has(x)));
  }
  for (const poi of Object.values(floor.pois)) {
    if (poi.span) poi.span = dedupePath(poi.span.filter((x) => !removed.has(x)));
  }
  sweepRooms(floor);
  sweepOutline(floor);
  syncDoorPois(floor);
}

export function deleteWallEdge(floor: Floor, key: string): void {
  const removed = new Set(deleteEdgeRaw(floor.walls, key));
  for (const r of Object.values(floor.rooms)) {
    r.loop = dedupeLoop(r.loop.filter((x) => !removed.has(x)));
  }
  if (floor.outline) {
    floor.outline = dedupeLoop(floor.outline.filter((x) => !removed.has(x)));
  }
  for (const poi of Object.values(floor.pois)) {
    if (poi.span) poi.span = dedupePath(poi.span.filter((x) => !removed.has(x)));
  }
  sweepRooms(floor);
  sweepOutline(floor);
  syncDoorPois(floor);
}

/** The only way to move a wall node — door POI spans re-center on it. Never
 *  write walls.nodes[id].x/y directly. */
export function moveWallNode(floor: Floor, id: NodeId, pt: Vec2): void {
  const n = floor.walls.nodes[id];
  if (!n) return;
  n.x = pt.x;
  n.y = pt.y;
  syncDoorPois(floor);
}

// ---------------------------------------------------------------------------
// Nav-layer wrappers (ripple into inter-floor links and POI links)
// ---------------------------------------------------------------------------

function cleanupNavRefs(p: Project, floorId: FloorId, removed: NodeId[]): void {
  if (!removed.length) return;
  const rm = new Set(removed);
  p.interFloorEdges = p.interFloorEdges.filter(
    (e) =>
      !(
        (e.from.floor === floorId && rm.has(e.from.node)) ||
        (e.to.floor === floorId && rm.has(e.to.node))
      ),
  );
  const floor = findFloor(p, floorId);
  if (floor) {
    for (const poi of Object.values(floor.pois)) {
      if (poi.navNodeId && rm.has(poi.navNodeId)) delete poi.navNodeId;
    }
  }
}

export function deleteNavNode(p: Project, floor: Floor, id: NodeId): void {
  cleanupNavRefs(p, floor.id, deleteNodeCascade(floor.nav, id));
}

export function deleteNavEdge(p: Project, floor: Floor, key: string): void {
  cleanupNavRefs(p, floor.id, deleteEdgeRaw(floor.nav, key));
}

export function sameLink(a: InterFloorEdge, b: InterFloorEdge): boolean {
  return (
    a.kind === b.kind &&
    a.oneWay === b.oneWay &&
    a.from.floor === b.from.floor &&
    a.from.node === b.from.node &&
    a.to.floor === b.to.floor &&
    a.to.node === b.to.node
  );
}

export function mergeNavNodes(p: Project, floor: Floor, keep: NodeId, drop: NodeId): void {
  mergeNodes(floor.nav, keep, drop);
  for (const e of p.interFloorEdges) {
    if (e.from.floor === floor.id && e.from.node === drop) e.from.node = keep;
    if (e.to.floor === floor.id && e.to.node === drop) e.to.node = keep;
  }
  p.interFloorEdges = p.interFloorEdges.filter((e, i, arr) => {
    if (e.from.floor === e.to.floor && e.from.node === e.to.node) return false;
    return arr.findIndex((o) => sameLink(o, e)) === i;
  });
  for (const poi of Object.values(floor.pois)) {
    if (poi.navNodeId === drop) poi.navNodeId = keep;
  }
}

// ---------------------------------------------------------------------------
// Drawing helper: edges split at every crossing
// ---------------------------------------------------------------------------

/** Adds the segment a—b, splitting BOTH the new segment and every existing edge
 *  it properly crosses, with a shared node at each intersection. Wall splits
 *  patch room loops. Shared endpoints / end-touches are not crossings. Returns
 *  the node chain a … b along the drawn segment ([] if nothing was drawn). */
export function addEdgeWithIntersections(
  p: Project,
  floor: Floor,
  layer: "walls" | "nav",
  a: NodeId,
  b: NodeId,
  kind?: string,
): NodeId[] {
  const g = layer === "walls" ? floor.walls : floor.nav;
  const A = g.nodes[a];
  const B = g.nodes[b];
  if (!A || !B || a === b) return [];

  const crossings: Array<{ key: string; point: Vec2; t: number }> = [];
  for (const [key, e] of Object.entries(g.edges)) {
    if (e.a === a || e.b === a || e.a === b || e.b === b) continue;
    const C = g.nodes[e.a];
    const D = g.nodes[e.b];
    if (!C || !D) continue;
    const hit = segSegIntersection(A, B, C, D);
    if (hit) crossings.push({ key, point: hit.point, t: hit.t });
  }

  if (!crossings.length) {
    addEdge(g, a, b, kind);
    return [a, b];
  }

  crossings.sort((x, y) => x.t - y.t);
  const chain: NodeId[] = [a];
  for (const c of crossings) {
    const nid = newId(p, "n");
    const made =
      layer === "walls" ? splitWallEdge(floor, c.key, c.point, nid) : splitEdge(g, c.key, c.point, nid);
    if (made) chain.push(nid);
  }
  chain.push(b);
  for (let i = 0; i + 1 < chain.length; i++) {
    addEdge(g, chain[i], chain[i + 1], kind);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Doors: a door is a wall path tagged kind:"door" plus exactly one POI spanning it
// ---------------------------------------------------------------------------

/** Makes `span` a door: tags every span edge kind:"door" (also when the edge
 *  pre-existed untagged) and creates its single door POI, x/y at the span
 *  midpoint. Returns the existing POI if one already spans exactly this path
 *  (either direction); null if the span isn't a valid wall path. Shared by the
 *  Door tool, the Wall tool's door mode, and the Edge inspector. */
export function createDoorPoi(p: Project, floor: Floor, span: NodeId[]): Poi | null {
  if (!pathEdgesValid(floor, span)) return null;
  const n = span.length;
  const same = (s: NodeId[]) =>
    s.length === n &&
    (s.every((id, i) => id === span[i]) || s.every((id, i) => id === span[n - 1 - i]));
  for (const poi of Object.values(floor.pois)) if (poi.span && same(poi.span)) return poi;
  for (let i = 0; i + 1 < n; i++) floor.walls.edges[edgeKey(span[i], span[i + 1])].kind = "door";
  const a = floor.walls.nodes[span[0]];
  const b = floor.walls.nodes[span[n - 1]];
  const id = newId(p, "p");
  const poi: Poi = {
    id,
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    type: "door",
    span: [...span],
  };
  floor.pois[id] = poi;
  return poi;
}

/** Door-tool cut: carves the sub-segment t1..t2 (parameters along the edge, a→b)
 *  out of a wall edge — splitting at each end unless it lies within `endTol` px
 *  of that end's node, in which case the node itself is reused — and makes it a
 *  door. Leftover pieces keep the original edge kind. Returns null when the door
 *  would be shorter than endTol. */
export function insertDoorOnEdge(
  p: Project,
  floor: Floor,
  key: string,
  t1: number,
  t2: number,
  endTol: number,
): Poi | null {
  const e = floor.walls.edges[key];
  if (!e) return null;
  const A = floor.walls.nodes[e.a];
  const B = floor.walls.nodes[e.b];
  if (!A || !B) return null;
  const len = dist(A, B);
  const tLo = Math.max(0, Math.min(t1, t2));
  const tHi = Math.min(1, Math.max(t1, t2));
  if ((tHi - tLo) * len < endTol) return null;
  const at = (t: number): Vec2 => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
  const { a, b } = e;
  let n1 = a;
  if (tLo * len > endTol) {
    n1 = newId(p, "n");
    splitWallEdge(floor, key, at(tLo), n1);
  }
  let n2 = b;
  if ((1 - tHi) * len > endTol) {
    n2 = newId(p, "n");
    splitWallEdge(floor, edgeKey(n1, b), at(tHi), n2);
  }
  return createDoorPoi(p, floor, [n1, n2]);
}

// ---------------------------------------------------------------------------
// POIs / floors / project
// ---------------------------------------------------------------------------

/** Deleting a room-POI deletes the room (and vice versa); the linked nav node always survives. */
export function deletePoi(p: Project, floor: Floor, poiId: PoiId): void {
  const poi = floor.pois[poiId];
  if (!poi) return;
  if (poi.roomId && floor.rooms[poi.roomId]) {
    deleteRoom(floor, poi.roomId); // also removes the POI
    return;
  }
  delete floor.pois[poiId];
}

export function deleteFloor(p: Project, floorId: FloorId): void {
  p.floors = p.floors.filter((f) => f.id !== floorId);
  p.interFloorEdges = p.interFloorEdges.filter(
    (e) => e.from.floor !== floorId && e.to.floor !== floorId,
  );
  if (p.floors.length === 0) p.floors.push(newFloor(p, "Floor 1"));
}

export function linksTouchingFloor(p: Project, floorId: FloorId): InterFloorEdge[] {
  return p.interFloorEdges.filter((e) => e.from.floor === floorId || e.to.floor === floorId);
}

export function linksTouchingNode(p: Project, floorId: FloorId, node: NodeId): InterFloorEdge[] {
  return p.interFloorEdges.filter(
    (e) =>
      (e.from.floor === floorId && e.from.node === node) ||
      (e.to.floor === floorId && e.to.node === node),
  );
}

/** Proportionally rescales everything drawn on a floor (used when its plan image
 *  is replaced by one with different dimensions, e.g. a higher-DPI re-import).
 *  Uniform scales carry the calibration along; non-uniform scales invalidate it. */
export function rescaleFloorGeometry(floor: Floor, fx: number, fy: number): void {
  for (const g of [floor.walls, floor.nav]) {
    for (const n of Object.values(g.nodes)) {
      n.x *= fx;
      n.y *= fy;
    }
  }
  for (const poi of Object.values(floor.pois)) {
    poi.x *= fx;
    poi.y *= fy;
  }
  if (floor.pxPerMeter != null) {
    if (Math.abs(fx - fy) < 1e-6) floor.pxPerMeter *= fx;
    else floor.pxPerMeter = null;
  }
}

function cloneGraph(g: Graph): Graph {
  const nodes: Record<NodeId, GraphNode> = {};
  for (const [id, n] of Object.entries(g.nodes)) nodes[id] = { ...n };
  const edges: Record<string, GraphEdge> = {};
  for (const [k, e] of Object.entries(g.edges)) edges[k] = { ...e };
  return { nodes, edges };
}

/** Deep clone for undo snapshots. floor.image objects are shared by reference —
 *  they are immutable, and copying multi-MB dataURLs per snapshot would be wasteful. */
export function cloneProject(p: Project): Project {
  return {
    ...p,
    floors: p.floors.map((f) => ({
      ...f,
      image: f.image,
      walls: cloneGraph(f.walls),
      nav: cloneGraph(f.nav),
      pois: Object.fromEntries(
        Object.entries(f.pois).map(([id, poi]) => [
          id,
          {
            ...poi,
            ...(poi.span ? { span: [...poi.span] } : {}),
            ...(poi.externalLink ? { externalLink: { ...poi.externalLink } } : {}),
          },
        ]),
      ),
      rooms: Object.fromEntries(
        Object.entries(f.rooms).map(([id, r]) => [id, { ...r, loop: [...r.loop] }]),
      ),
      outline: f.outline ? [...f.outline] : null,
    })),
    interFloorEdges: p.interFloorEdges.map((e) => ({
      ...e,
      from: { ...e.from },
      to: { ...e.to },
    })),
  };
}
