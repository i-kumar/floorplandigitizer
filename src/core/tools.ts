// Tools + input routing. The pan/zoom controller intercepts first (it works in
// every mode); everything else goes to the active tool's pointer state machine.
import * as M from "./model";
import { snap, SNAP, type SnapResult } from "./snap";
import { hitTest } from "./hit";
import { canonicalLoopKey, faceAtPoint, traceFaces, type Face } from "./rooms";
import { dist, polygonCentroid } from "./geometry";
import {
  docStore,
  editorStore,
  overlayStore,
  sameRef,
  type ItemRef,
  type LayerId,
  type ToolId,
} from "./store";

export interface PointerInfo {
  img: M.Vec2;
  screen: M.Vec2;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface Tool {
  onDown(e: PointerInfo): void;
  onMove(e: PointerInfo): void;
  onUp(e: PointerInfo): void;
  onRightDown?(e: PointerInfo): void;
  onDoubleClick?(e: PointerInfo): void;
  /** Return true if the key was consumed. */
  onKey?(e: KeyboardEvent): boolean;
  /** Chain tools consume undo/redo to step the chain back/forward. */
  handleUndo?(): boolean;
  handleRedo?(): boolean;
  deactivate(): void;
}

const currentFloor = (): M.Floor => M.findFloor(docStore.project, editorStore.floorId)!;
const zoom = (): number => overlayStore.viewport.zoom;

// ---------------------------------------------------------------------------
// Select tool
// ---------------------------------------------------------------------------

class SelectTool implements Tool {
  private mode: "idle" | "pressed" | "dragging" = "idle";
  private start: M.Vec2 = { x: 0, y: 0 };
  private dragRef: ItemRef | null = null;
  private lastSnap: SnapResult | null = null;

  onDown(e: PointerInfo): void {
    const f = currentFloor();

    // Complete an armed inter-floor link on nav-node click.
    const link = editorStore.linking;
    if (link) {
      const hit = hitTest(f, "nav", e.img, zoom());
      if (hit && hit.kind === "node") {
        if (link.from.floor === f.id) {
          editorStore.toast("Pick a nav node on a different floor (Esc to cancel)");
          return;
        }
        docStore.transact((p) => {
          p.interFloorEdges.push({
            from: { ...link.from },
            to: { floor: f.id, node: hit.id },
            kind: link.kind,
            oneWay: link.oneWay,
          });
        });
        editorStore.update((s) => {
          s.linking = null;
          s.selection = hit;
        });
        editorStore.toast(`${link.kind} link created`);
        return;
      }
      // fall through: normal selection, linking stays armed
    }

    const hit = hitTest(f, editorStore.layer, e.img, zoom());
    if (!sameRef(hit, editorStore.selection)) {
      editorStore.update((s) => {
        s.selection = hit;
      });
    }
    if (hit && (hit.kind === "node" || hit.kind === "poi")) {
      this.mode = "pressed";
      this.start = e.img;
      this.dragRef = hit;
      this.lastSnap = null;
      docStore.beginGesture();
    }
  }

  onMove(e: PointerInfo): void {
    const f = currentFloor();
    if (this.mode === "pressed" && dist(e.img, this.start) * zoom() > SNAP.minDrag) {
      this.mode = "dragging";
    }
    if (this.mode === "dragging" && this.dragRef) {
      const ref = this.dragRef;
      if (ref.kind === "node") {
        const g = ref.layer === "walls" ? f.walls : f.nav;
        const res = snap({
          cursor: e.img,
          graph: g,
          anchor: null,
          zoom: zoom(),
          exclude: ref.id,
          shift: e.shift,
          alt: e.alt,
        });
        this.lastSnap = res;
        docStore.mutate((p) => {
          const fl = M.findFloor(p, f.id);
          const n = fl && (ref.layer === "walls" ? fl.walls : fl.nav).nodes[ref.id];
          if (n) {
            n.x = res.point.x;
            n.y = res.point.y;
          }
        });
        overlayStore.update((s) => {
          s.snapPreview = res;
        });
      } else if (ref.kind === "poi") {
        // POIs snap against walls so door-POIs land exactly on door edges.
        const res = snap({
          cursor: e.img,
          graph: f.walls,
          anchor: null,
          zoom: zoom(),
          shift: e.shift,
          alt: e.alt,
        });
        docStore.mutate((p) => {
          const fl = M.findFloor(p, f.id);
          const poi = fl?.pois[ref.id];
          if (poi) {
            poi.x = res.point.x;
            poi.y = res.point.y;
          }
        });
        overlayStore.update((s) => {
          s.snapPreview = res;
        });
      }
      return;
    }
    const hit = hitTest(f, editorStore.layer, e.img, zoom());
    if (!sameRef(hit, overlayStore.hover)) {
      overlayStore.update((s) => {
        s.hover = hit;
      });
    }
  }

  onUp(_e: PointerInfo): void {
    if (this.mode === "dragging" && this.dragRef) {
      const ref = this.dragRef;
      const res = this.lastSnap;
      const fid = editorStore.floorId;
      if (ref.kind === "node" && res && (res.kind === "node" || res.kind === "segment")) {
        docStore.mutate((p) => {
          const fl = M.findFloor(p, fid);
          if (!fl) return;
          if (res.kind === "node" && res.node !== ref.id) {
            if (ref.layer === "walls") M.mergeWallNodes(fl, res.node, ref.id);
            else M.mergeNavNodes(p, fl, res.node, ref.id);
            editorStore.update((s) => {
              s.selection = { kind: "node", layer: ref.layer, id: res.node };
            });
          } else if (res.kind === "segment") {
            const nid = M.newId(p, "n");
            if (ref.layer === "walls") {
              M.splitWallEdge(fl, res.edge, res.point, nid);
              M.mergeWallNodes(fl, nid, ref.id);
            } else {
              M.splitEdge(fl.nav, res.edge, res.point, nid);
              M.mergeNavNodes(p, fl, nid, ref.id);
            }
            editorStore.update((s) => {
              s.selection = { kind: "node", layer: ref.layer, id: nid };
            });
          }
        });
      }
      docStore.endGesture();
    } else if (this.mode === "pressed") {
      docStore.abortGesture(); // plain selection click
    }
    this.mode = "idle";
    this.dragRef = null;
    this.lastSnap = null;
    if (overlayStore.snapPreview) {
      overlayStore.update((s) => {
        s.snapPreview = null;
      });
    }
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (editorStore.linking) {
        editorStore.update((s) => {
          s.linking = null;
        });
        return true;
      }
      if (editorStore.selection) {
        editorStore.update((s) => {
          s.selection = null;
        });
        return true;
      }
    }
    return false;
  }

  deactivate(): void {
    if (this.mode !== "idle") {
      docStore.abortGesture();
      this.mode = "idle";
      this.dragRef = null;
    }
    overlayStore.update((s) => {
      s.snapPreview = null;
      s.hover = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Chain tool (walls + paths — the same machine, parameterized by layer)
// ---------------------------------------------------------------------------

interface ChainEntry {
  id: M.NodeId;
  /** Whether this click committed a doc transaction (false when the chain merely
   *  re-anchored to an existing node / duplicate edge — nothing to undo). */
  txn: boolean;
}

class ChainTool implements Tool {
  private placed: ChainEntry[] = [];
  private unplaced: ChainEntry[] = [];
  private lastTxnVersion = -1;

  constructor(private layer: "walls" | "nav") {}

  private graph(): M.Graph {
    const f = currentFloor();
    return this.layer === "walls" ? f.walls : f.nav;
  }

  private anchorPos(): M.Vec2 | null {
    const a = editorStore.chainAnchor;
    if (!a) return null;
    const n = this.graph().nodes[a];
    return n ? { x: n.x, y: n.y } : null;
  }

  private computeSnap(e: PointerInfo): SnapResult {
    const f = currentFloor();
    return snap({
      cursor: e.img,
      graph: this.graph(),
      pois: this.layer === "nav" ? Object.values(f.pois) : undefined,
      anchor: this.anchorPos(),
      zoom: zoom(),
      shift: e.shift,
      alt: e.alt,
    });
  }

  onMove(e: PointerInfo): void {
    overlayStore.update((s) => {
      s.snapPreview = this.computeSnap(e);
    });
  }

  onDown(e: PointerInfo): void {
    const res = this.computeSnap(e);
    const anchor = editorStore.chainAnchor;

    if (res.kind === "node") {
      if (res.node === anchor) return; // clicking the tail again does nothing
      if (!anchor) {
        // Start a chain from an existing node — no doc change.
        this.placed.push({ id: res.node, txn: false });
        this.unplaced = [];
        editorStore.update((s) => {
          s.chainAnchor = res.node;
        });
        return;
      }
      // Connecting the anchor to an existing node whose edge already exists:
      // nothing to commit, just advance the anchor.
      if (this.graph().edges[M.edgeKey(anchor, res.node)]) {
        this.placed.push({ id: res.node, txn: false });
        this.unplaced = [];
        editorStore.update((s) => {
          s.chainAnchor = res.node;
        });
        return;
      }
    }

    const fid = editorStore.floorId;
    const layer = this.layer;
    const door = layer === "walls" && editorStore.doorMode;
    let newAnchor: M.NodeId = "";
    docStore.transact((p) => {
      const fl = M.findFloor(p, fid)!;
      const g = layer === "walls" ? fl.walls : fl.nav;
      let target: M.NodeId;
      if (res.kind === "node") {
        target = res.node;
      } else if (res.kind === "segment" || res.kind === "angle-segment") {
        const nid = M.newId(p, "n");
        if (layer === "walls") M.splitWallEdge(fl, res.edge, res.point, nid);
        else M.splitEdge(g, res.edge, res.point, nid);
        target = nid;
      } else if (res.kind === "poi") {
        const nid = M.newId(p, "n");
        M.addNode(g, res.point, nid);
        const poi = fl.pois[res.poi];
        if (poi) poi.navNodeId = nid;
        target = nid;
      } else {
        const nid = M.newId(p, "n");
        M.addNode(g, res.point, nid);
        target = nid;
      }
      if (anchor && g.nodes[anchor]) {
        // Splits the drawn segment and any edges it crosses, sharing a node at
        // each intersection.
        M.addEdgeWithIntersections(p, fl, layer, anchor, target, door ? "door" : undefined);
      }
      newAnchor = target;
    });
    this.lastTxnVersion = docStore.version;
    this.placed.push({ id: newAnchor, txn: true });
    this.unplaced = [];
    editorStore.update((s) => {
      s.chainAnchor = newAnchor;
    });
  }

  onUp(_e: PointerInfo): void {}

  onRightDown(_e: PointerInfo): void {
    this.stepBack();
  }

  onDoubleClick(_e: PointerInfo): void {
    this.endChain();
  }

  /** Right-click and Ctrl+Z share this path: undo the click AND re-anchor. */
  private stepBack(): boolean {
    if (!this.placed.length) return false;
    const last = this.placed.pop()!;
    if (last.txn) docStore.undo();
    this.unplaced.push(last);
    const tail = this.placed[this.placed.length - 1] ?? null;
    editorStore.update((s) => {
      s.chainAnchor = tail ? tail.id : null;
    });
    overlayStore.update((s) => {
      s.snapPreview = null;
    });
    return true;
  }

  handleUndo(): boolean {
    return this.stepBack();
  }

  handleRedo(): boolean {
    if (!this.unplaced.length) return false;
    const item = this.unplaced.pop()!;
    if (item.txn && !docStore.redo()) {
      this.unplaced.push(item);
      return false;
    }
    this.placed.push(item);
    editorStore.update((s) => {
      s.chainAnchor = item.id;
    });
    return true;
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter") {
      if (editorStore.chainAnchor || this.placed.length) {
        this.endChain();
        return true;
      }
      return false;
    }
    if ((e.key === "d" || e.key === "D") && this.layer === "walls") {
      editorStore.update((s) => {
        s.doorMode = !s.doorMode;
      });
      return true;
    }
    return false;
  }

  /** Ends the chain KEEPING committed segments (Esc = "stop extending", not "revert").
   *  Exception: a single freshly-created degree-0 point is removed (no lone graph nodes). */
  private endChain(): void {
    if (this.placed.length === 1 && this.placed[0].txn) {
      const id = this.placed[0].id;
      const g = this.graph();
      if (g.nodes[id] && M.degree(g, id) === 0) {
        if (docStore.version === this.lastTxnVersion) {
          docStore.undo(); // safe: our creation click is still the latest transaction
        } else {
          const fid = editorStore.floorId;
          const layer = this.layer;
          docStore.transact((p) => {
            const fl = M.findFloor(p, fid)!;
            if (layer === "walls") M.deleteWallNode(fl, id);
            else M.deleteNavNode(p, fl, id);
          });
        }
      }
    }
    this.placed = [];
    this.unplaced = [];
    editorStore.update((s) => {
      s.chainAnchor = null;
      s.doorMode = false;
    });
    overlayStore.update((s) => {
      s.snapPreview = null;
    });
  }

  deactivate(): void {
    this.endChain();
  }
}

// ---------------------------------------------------------------------------
// POI tool
// ---------------------------------------------------------------------------

class PoiTool implements Tool {
  private computeSnap(e: PointerInfo): SnapResult {
    // POIs snap against the walls graph (node + segment) — e.g. a door POI
    // placed exactly on a door edge.
    const f = currentFloor();
    return snap({
      cursor: e.img,
      graph: f.walls,
      anchor: null,
      zoom: zoom(),
      shift: e.shift,
      alt: e.alt,
    });
  }

  onMove(e: PointerInfo): void {
    overlayStore.update((s) => {
      s.snapPreview = this.computeSnap(e);
    });
  }

  onDown(e: PointerInfo): void {
    const res = this.computeSnap(e);
    const fid = editorStore.floorId;
    let pid = "";
    docStore.transact((p) => {
      const fl = M.findFloor(p, fid)!;
      pid = M.newId(p, "p");
      const last = editorStore.lastPoiType;
      const type =
        last && p.poiTypes.includes(last)
          ? last
          : p.poiTypes.find((t) => t !== "room") ?? "poi";
      fl.pois[pid] = { id: pid, x: res.point.x, y: res.point.y, type };
    });
    editorStore.update((s) => {
      s.selection = { kind: "poi", id: pid };
      s.focusNonce++;
    });
  }

  onUp(_e: PointerInfo): void {}

  deactivate(): void {
    overlayStore.update((s) => {
      s.snapPreview = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Room tool
// ---------------------------------------------------------------------------

class RoomTool implements Tool {
  private cache: { version: number; floorId: string; faces: Face[] } | null = null;
  private current: Face | null = null;

  private faces(): Face[] {
    const f = currentFloor();
    if (
      !this.cache ||
      this.cache.version !== docStore.version ||
      this.cache.floorId !== f.id
    ) {
      this.cache = { version: docStore.version, floorId: f.id, faces: traceFaces(f.walls) };
    }
    return this.cache.faces;
  }

  onMove(e: PointerInfo): void {
    const f = currentFloor();
    const face = faceAtPoint(f.walls, this.faces(), e.img);
    this.current = face;
    overlayStore.update((s) => {
      s.roomPreview = face
        ? face.loop.map((id) => ({ x: f.walls.nodes[id].x, y: f.walls.nodes[id].y }))
        : null;
    });
  }

  onDown(e: PointerInfo): void {
    this.onMove(e);
    const face = this.current;
    if (!face) {
      editorStore.toast(
        "Not an enclosed region — close the walls, or bridge doorways with door edges (press D while drawing walls)",
      );
      return;
    }
    const f = currentFloor();
    const key = canonicalLoopKey(face.loop);
    const existing = Object.values(f.rooms).find((r) => canonicalLoopKey(r.loop) === key);
    if (existing) {
      editorStore.update((s) => {
        s.selection = { kind: "room", id: existing.id };
      });
      return;
    }
    const fid = f.id;
    let rid = "";
    docStore.transact((p) => {
      const fl = M.findFloor(p, fid)!;
      rid = M.newId(p, "r");
      const pid = M.newId(p, "p");
      const pts = face.loop.map((id) => fl.walls.nodes[id]);
      const c = polygonCentroid(pts);
      const name = `Room ${Object.keys(fl.rooms).length + 1}`;
      fl.rooms[rid] = { id: rid, name, loop: [...face.loop], poiId: pid };
      fl.pois[pid] = { id: pid, x: c.x, y: c.y, type: "room", name, roomId: rid };
    });
    editorStore.update((s) => {
      s.selection = { kind: "room", id: rid };
      s.focusNonce++;
    });
  }

  onUp(_e: PointerInfo): void {}

  deactivate(): void {
    this.current = null;
    overlayStore.update((s) => {
      s.roomPreview = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Calibrate tool
// ---------------------------------------------------------------------------

class CalibrateTool implements Tool {
  onDown(e: PointerInfo): void {
    if (!editorStore.calibPoint) {
      editorStore.update((s) => {
        s.calibPoint = e.img;
      });
      return;
    }
    const p1 = editorStore.calibPoint;
    const px = dist(p1, e.img);
    if (px * zoom() < 4) return; // ignore accidental double-click in place
    const input = window.prompt(
      `Real-world length of this line, in meters?\n(pixel length: ${px.toFixed(1)} px)`,
    );
    editorStore.update((s) => {
      s.calibPoint = null;
    });
    if (input == null || input.trim() === "") return;
    const meters = parseFloat(input.replace(",", "."));
    if (!isFinite(meters) || meters <= 0) {
      editorStore.toast("Invalid distance — calibration unchanged");
      return;
    }
    const fid = editorStore.floorId;
    docStore.transact((p) => {
      const fl = M.findFloor(p, fid)!;
      fl.pxPerMeter = px / meters;
    });
    editorStore.toast(`Calibrated: ${(px / meters).toFixed(2)} px per meter`);
  }

  onMove(_e: PointerInfo): void {}
  onUp(_e: PointerInfo): void {}

  onKey(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && editorStore.calibPoint) {
      editorStore.update((s) => {
        s.calibPoint = null;
      });
      return true;
    }
    return false;
  }

  deactivate(): void {
    editorStore.update((s) => {
      s.calibPoint = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Registry + global actions
// ---------------------------------------------------------------------------

export const tools: Record<ToolId, Tool> = {
  select: new SelectTool(),
  wall: new ChainTool("walls"),
  path: new ChainTool("nav"),
  poi: new PoiTool(),
  room: new RoomTool(),
  calibrate: new CalibrateTool(),
};

export function activeTool(): Tool {
  return tools[editorStore.tool];
}

const TOOL_LAYERS: Partial<Record<ToolId, LayerId>> = {
  wall: "walls",
  path: "nav",
  poi: "pois",
  room: "walls",
};

export function setTool(t: ToolId): void {
  if (editorStore.tool === t) return;
  activeTool().deactivate();
  editorStore.update((s) => {
    s.tool = t;
    const layer = TOOL_LAYERS[t];
    if (layer) s.layer = layer;
  });
  overlayStore.update((s) => {
    s.snapPreview = null;
    s.hover = null;
  });
}

export function setLayer(l: LayerId): void {
  if (editorStore.layer === l) return;
  editorStore.update((s) => {
    s.layer = l;
    s.selection = null;
  });
  overlayStore.update((s) => {
    s.hover = null;
  });
}

export function setFloor(fid: M.FloorId): void {
  if (fid === editorStore.floorId) return;
  if (!M.findFloor(docStore.project, fid)) return;
  activeTool().deactivate();
  editorStore.update((s) => {
    s.floorId = fid;
    s.selection = null;
  });
  overlayStore.update((s) => {
    s.hover = null;
    s.snapPreview = null;
    s.roomPreview = null;
  });
}

/** Undo/redo routed through the active tool first (chain step-back/forward). */
export function performUndo(): void {
  if (activeTool().handleUndo?.()) return;
  docStore.undo();
}

export function performRedo(): void {
  if (activeTool().handleRedo?.()) return;
  docStore.redo();
}

export function deleteSelection(): void {
  const sel = editorStore.selection;
  if (!sel) return;
  if (sel.kind === "room") {
    const f = currentFloor();
    const room = f.rooms[sel.id];
    if (room && !window.confirm(`Delete room "${room.name}" (and its POI)?`)) return;
  }
  if (sel.kind === "poi") {
    const f = currentFloor();
    const poi = f.pois[sel.id];
    if (poi?.roomId && f.rooms[poi.roomId]) {
      if (!window.confirm(`This POI belongs to room "${f.rooms[poi.roomId].name}" — delete both?`))
        return;
    }
  }
  const fid = editorStore.floorId;
  docStore.transact((p) => {
    const fl = M.findFloor(p, fid);
    if (!fl) return;
    switch (sel.kind) {
      case "node":
        if (sel.layer === "walls") M.deleteWallNode(fl, sel.id);
        else M.deleteNavNode(p, fl, sel.id);
        break;
      case "edge":
        if (sel.layer === "walls") M.deleteWallEdge(fl, sel.key);
        else M.deleteNavEdge(p, fl, sel.key);
        break;
      case "poi":
        M.deletePoi(p, fl, sel.id);
        break;
      case "room":
        M.deleteRoom(fl, sel.id);
        break;
    }
  });
  editorStore.update((s) => {
    s.selection = null;
  });
  overlayStore.update((s) => {
    s.hover = null;
  });
}

export function zoomAt(screen: M.Vec2, factor: number): void {
  const v = overlayStore.viewport;
  const nz = Math.min(32, Math.max(0.05, v.zoom * factor));
  if (nz === v.zoom) return;
  overlayStore.update((s) => {
    s.viewport.x = screen.x - (screen.x - s.viewport.x) * (nz / s.viewport.zoom);
    s.viewport.y = screen.y - (screen.y - s.viewport.y) * (nz / s.viewport.zoom);
    s.viewport.zoom = nz;
  });
}

export function zoomBy(factor: number): void {
  zoomAt({ x: overlayStore.viewW / 2, y: overlayStore.viewH / 2 }, factor);
}

/** Fit the floor image (or the drawn content) into the view. */
export function fitView(): void {
  const f = currentFloor();
  let w = f.image?.width ?? 0;
  let h = f.image?.height ?? 0;
  let ox = 0;
  let oy = 0;
  if (!w || !h) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const g of [f.walls, f.nav]) {
      for (const n of Object.values(g.nodes)) {
        xs.push(n.x);
        ys.push(n.y);
      }
    }
    for (const poi of Object.values(f.pois)) {
      xs.push(poi.x);
      ys.push(poi.y);
    }
    if (!xs.length) {
      overlayStore.update((s) => {
        s.viewport = { x: 60, y: 60, zoom: 0.35 };
      });
      return;
    }
    ox = Math.min(...xs);
    oy = Math.min(...ys);
    w = Math.max(...xs) - ox || 100;
    h = Math.max(...ys) - oy || 100;
  }
  const zoomFit = Math.min(overlayStore.viewW / w, overlayStore.viewH / h) * 0.92;
  const z = Math.min(32, Math.max(0.05, zoomFit));
  overlayStore.update((s) => {
    s.viewport.zoom = z;
    s.viewport.x = (overlayStore.viewW - w * z) / 2 - ox * z;
    s.viewport.y = (overlayStore.viewH - h * z) / 2 - oy * z;
  });
}

// ---------------------------------------------------------------------------
// Input router (pan/zoom first, then the active tool)
// ---------------------------------------------------------------------------

export const router = {
  panning: null as null | { pointerId: number; last: M.Vec2 },

  onPointerDown(e: PointerEvent, info: PointerInfo): void {
    if (e.button === 1 || (e.button === 0 && editorStore.spaceDown)) {
      this.panning = { pointerId: e.pointerId, last: info.screen };
      return;
    }
    if (e.button === 0) activeTool().onDown(info);
    else if (e.button === 2) activeTool().onRightDown?.(info);
  },

  onPointerMove(e: PointerEvent, info: PointerInfo): void {
    overlayStore.update((s) => {
      s.cursor = info.img;
    });
    if (this.panning && e.pointerId === this.panning.pointerId) {
      const dx = info.screen.x - this.panning.last.x;
      const dy = info.screen.y - this.panning.last.y;
      this.panning.last = info.screen;
      overlayStore.update((s) => {
        s.viewport.x += dx;
        s.viewport.y += dy;
      });
      return;
    }
    activeTool().onMove(info);
  },

  onPointerUp(e: PointerEvent, info: PointerInfo): void {
    if (this.panning && e.pointerId === this.panning.pointerId) {
      this.panning = null;
      return;
    }
    if (e.button === 0) activeTool().onUp(info);
  },

  onPointerCancel(): void {
    this.panning = null;
    activeTool().deactivate();
  },

  onWheel(e: WheelEvent, screen: M.Vec2): void {
    zoomAt(screen, Math.exp(-e.deltaY * 0.0015));
  },

  onDoubleClick(info: PointerInfo): void {
    activeTool().onDoubleClick?.(info);
  },
};
