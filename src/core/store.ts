// Two plain-TS stores. Both mutate in place and bump an integer `version`;
// React binds via useSyncExternalStore(subscribe, () => store.version).
//
//   docStore     — the persisted Project + snapshot-based undo/redo (cap 20)
//   editorStore  — ephemeral editor state (tool, selection, linking, toasts, ...)
//   overlayStore — high-frequency ephemeral state (viewport, cursor, snap previews)
//                  kept separate so per-pointer-move updates don't re-render the chrome.
import {
  cloneProject,
  findFloor,
  newProject,
  type FloorId,
  type LinkKind,
  type NodeId,
  type Project,
  type Vec2,
} from "./model";
import type { SnapResult } from "./snap";

const UNDO_CAP = 20;

type Listener = () => void;

class BaseStore {
  version = 0;
  private listeners = new Set<Listener>();
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  protected emit(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
}

export class DocStore extends BaseStore {
  project: Project = newProject();
  undoStack: Project[] = [];
  redoStack: Project[] = [];
  private pending: Project | null = null;

  /** One atomic mutation = one undo step. `fn` must be synchronous. */
  transact(fn: (p: Project) => void): void {
    const before = cloneProject(this.project);
    fn(this.project);
    this.pushUndo(before);
    this.redoStack = [];
    this.emit();
  }

  /** Start of a drag-style gesture: checkpoint now, commit at endGesture. */
  beginGesture(): void {
    this.pending = cloneProject(this.project);
  }

  /** Mutation during a gesture (per pointer-move) — no history, just notify. */
  mutate(fn: (p: Project) => void): void {
    fn(this.project);
    this.emit();
  }

  endGesture(): void {
    if (!this.pending) return;
    this.pushUndo(this.pending);
    this.pending = null;
    this.redoStack = [];
    this.emit();
  }

  /** Discard the gesture: restore the checkpoint (covers clicks and cancelled drags). */
  abortGesture(): void {
    if (!this.pending) return;
    this.project = this.pending;
    this.pending = null;
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.project);
    this.project = this.undoStack.pop()!;
    this.emit();
    return true;
  }

  redo(): boolean {
    if (!this.redoStack.length) return false;
    this.pushUndo(this.project);
    this.project = this.redoStack.pop()!;
    this.emit();
    return true;
  }

  /** File load / new project: clears all history. */
  replace(p: Project): void {
    this.project = p;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.emit();
  }

  private pushUndo(snapshot: Project): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
  }
}

export type ToolId = "select" | "wall" | "path" | "poi" | "room" | "calibrate";
export type LayerId = "walls" | "nav" | "pois";

export type ItemRef =
  | { kind: "node"; layer: "walls" | "nav"; id: NodeId }
  | { kind: "edge"; layer: "walls" | "nav"; key: string }
  | { kind: "poi"; id: string }
  | { kind: "room"; id: string };

export function sameRef(a: ItemRef | null, b: ItemRef | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "edge" && b.kind === "edge") return a.layer === b.layer && a.key === b.key;
  if (a.kind === "node" && b.kind === "node") return a.layer === b.layer && a.id === b.id;
  if ((a.kind === "poi" && b.kind === "poi") || (a.kind === "room" && b.kind === "room")) {
    return a.id === b.id;
  }
  return false;
}

export interface Toast {
  id: number;
  msg: string;
}

export class EditorStore extends BaseStore {
  tool: ToolId = "select";
  layer: LayerId = "walls";
  floorId: FloorId = "";
  imageOpacity = 0.5;
  chainAnchor: NodeId | null = null;
  doorMode = false;
  selection: ItemRef | null = null;
  linking: { from: { floor: FloorId; node: NodeId }; kind: LinkKind; oneWay: boolean } | null =
    null;
  calibPoint: Vec2 | null = null;
  spaceDown = false;
  lastPoiType: string | null = null;
  focusNonce = 0; // bumped when the Inspector should focus its name field
  toasts: Toast[] = [];

  update(fn: (s: EditorStore) => void): void {
    fn(this);
    this.emit();
  }

  toast(msg: string): void {
    const id = Date.now() + Math.random();
    this.toasts.push({ id, msg });
    this.emit();
    setTimeout(() => {
      this.update((s) => {
        s.toasts = s.toasts.filter((t) => t.id !== id);
      });
    }, 4000);
  }
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number; // screen px per image px
}

export class OverlayStore extends BaseStore {
  viewport: Viewport = { x: 60, y: 60, zoom: 0.35 };
  viewW = 800;
  viewH = 600;
  cursor: Vec2 | null = null;
  snapPreview: SnapResult | null = null;
  roomPreview: Vec2[] | null = null;
  hover: ItemRef | null = null;

  update(fn: (s: OverlayStore) => void): void {
    fn(this);
    this.emit();
  }
}

export const docStore = new DocStore();
export const editorStore = new EditorStore();
export const overlayStore = new OverlayStore();

editorStore.floorId = docStore.project.floors[0].id;

function refExists(ref: ItemRef, floorId: FloorId): boolean {
  const floor = findFloor(docStore.project, floorId);
  if (!floor) return false;
  switch (ref.kind) {
    case "node":
      return !!(ref.layer === "walls" ? floor.walls : floor.nav).nodes[ref.id];
    case "edge":
      return !!(ref.layer === "walls" ? floor.walls : floor.nav).edges[ref.key];
    case "poi":
      return !!floor.pois[ref.id];
    case "room":
      return !!floor.rooms[ref.id];
  }
}

// Keep editor refs valid whenever the document changes (undo/redo/replace/deletes).
docStore.subscribe(() => {
  const p = docStore.project;
  let editorChanged = false;
  let overlayChanged = false;

  if (!findFloor(p, editorStore.floorId)) {
    editorStore.floorId = p.floors[0].id;
    editorStore.selection = null;
    editorStore.chainAnchor = null;
    editorStore.linking = null;
    overlayStore.hover = null;
    overlayStore.snapPreview = null;
    overlayStore.roomPreview = null;
    editorChanged = true;
    overlayChanged = true;
  }
  const fid = editorStore.floorId;
  if (editorStore.selection && !refExists(editorStore.selection, fid)) {
    editorStore.selection = null;
    editorChanged = true;
  }
  if (overlayStore.hover && !refExists(overlayStore.hover, fid)) {
    overlayStore.hover = null;
    overlayChanged = true;
  }
  if (editorStore.chainAnchor) {
    const floor = findFloor(p, fid)!;
    if (!floor.walls.nodes[editorStore.chainAnchor] && !floor.nav.nodes[editorStore.chainAnchor]) {
      editorStore.chainAnchor = null;
      overlayStore.snapPreview = null;
      editorChanged = true;
      overlayChanged = true;
    }
  }
  if (editorStore.linking) {
    const lf = findFloor(p, editorStore.linking.from.floor);
    if (!lf || !lf.nav.nodes[editorStore.linking.from.node]) {
      editorStore.linking = null;
      editorChanged = true;
    }
  }

  if (editorChanged) editorStore.update(() => {});
  if (overlayChanged) overlayStore.update(() => {});
});
