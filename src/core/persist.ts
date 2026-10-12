// Persistence: IndexedDB autosave (localStorage's ~5MB quota can't hold embedded
// floor plan images) + explicit .floorplan.json save/load.
import { emptyGraph, mintIdPrefix, pathEdgesValid, type Project } from "./model";
import { importMapJson } from "./interchange";
import { docStore, editorStore } from "./store";

const DB_NAME = "floorplan-tool";
const STORE = "kv";
const AUTOSAVE_KEY = "autosave";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function kvSet(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function kvDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Shape-check a parsed object and fill defaults for fields added since it was saved.
 *  Throws on anything unusable. */
export function validateProject(obj: unknown): Project {
  const p = obj as Project;
  if (!p || typeof p !== "object") throw new Error("Not a project file");
  if (p.version !== 1) throw new Error(`Unsupported project version: ${String(p.version)}`);
  if (!Array.isArray(p.floors) || p.floors.length === 0) throw new Error("Project has no floors");
  if (typeof p.building !== "string") p.building = "Building";
  if (typeof p.buildingId !== "string") p.buildingId = "";
  if (!Array.isArray(p.interFloorEdges)) p.interFloorEdges = [];
  delete (p as { poiTypes?: unknown }).poiTypes; // vocabularies are code now (vocab.ts)
  if (typeof p.idPrefix !== "string" || !p.idPrefix) p.idPrefix = mintIdPrefix();
  if (typeof p.idCounter !== "number") p.idCounter = 0;
  for (const f of p.floors) {
    if (!f || typeof f.id !== "string") throw new Error("Malformed floor entry");
    if (typeof f.name !== "string") f.name = "Floor";
    if (f.image !== null && (typeof f.image?.dataUrl !== "string" || !f.image.width)) {
      f.image = null;
    }
    if (typeof f.pxPerMeter !== "number") f.pxPerMeter = null;
    if (!f.walls || typeof f.walls !== "object") f.walls = emptyGraph();
    if (!f.nav || typeof f.nav !== "object") f.nav = emptyGraph();
    f.walls.nodes ??= {};
    f.walls.edges ??= {};
    f.nav.nodes ??= {};
    f.nav.edges ??= {};
    f.pois ??= {};
    f.rooms ??= {};
    for (const [id, poi] of Object.entries(f.pois)) {
      if (!poi || typeof poi !== "object") {
        delete f.pois[id];
        continue;
      }
      if (
        poi.span !== undefined &&
        !(Array.isArray(poi.span) && poi.span.every((x) => typeof x === "string") && pathEdgesValid(f, poi.span))
      ) {
        delete poi.span;
      }
      if (poi.access !== undefined && poi.access !== "emergency_only") delete poi.access;
      const l = poi.externalLink;
      if (l !== undefined && !(l && typeof l === "object" && typeof l.building === "string" && typeof l.key === "string")) {
        delete poi.externalLink;
      }
    }
    if (!Array.isArray(f.outline) || !f.outline.every((x) => typeof x === "string")) {
      f.outline = null;
    }
    if (
      f.expectedImageSize &&
      !(typeof f.expectedImageSize.width === "number" && typeof f.expectedImageSize.height === "number")
    ) {
      delete f.expectedImageSize;
    }
  }
  return p;
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const saved = await kvGet<Project>(AUTOSAVE_KEY);
    return saved ? validateProject(saved) : null;
  } catch {
    return null;
  }
}

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let firstPendingAt: number | null = null;
let warnedOnce = false;

/** Debounced autosave with a hard ceiling: a quiet moment saves after 500ms,
 *  but continuous editing still flushes at least every 2s (a plain debounce
 *  would keep deferring forever and lose everything on a quick reload). */
export function startAutosave(): void {
  const save = () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    firstPendingAt = null;
    kvSet(AUTOSAVE_KEY, docStore.project).catch(() => {
      if (!warnedOnce) {
        warnedOnce = true;
        editorStore.toast("Autosave failed — save your project to a file to be safe");
      }
    });
  };
  docStore.subscribe(() => {
    const now = Date.now();
    if (firstPendingAt === null) firstPendingAt = now;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(save, now - firstPendingAt >= 2000 ? 0 : 500);
  });
  // Best-effort flush when the tab is being hidden/closed.
  const flushIfPending = () => {
    if (firstPendingAt !== null) save();
  };
  window.addEventListener("pagehide", flushIfPending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushIfPending();
  });
}

export async function clearAutosave(): Promise<void> {
  await kvDel(AUTOSAVE_KEY).catch(() => {});
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function saveProjectFile(): void {
  const p = docStore.project;
  const name = (p.building || "building").replace(/[^\w\- ]+/g, "").trim() || "building";
  download(`${name}.floorplan.json`, new Blob([JSON.stringify(p)], { type: "application/json" }));
}

/** Accepts a .floorplan.json project OR an exported .map.json (rebuilt into an
 *  editable project — minus plan images). Throws on anything else. */
export function parseProjectFileText(text: string): {
  project: Project;
  warnings: string[];
  kind: "project" | "map";
} {
  const obj = JSON.parse(text) as { version?: unknown };
  if (obj && typeof obj === "object" && obj.version === 1) {
    return { project: validateProject(obj), warnings: [], kind: "project" };
  }
  const { project, warnings } = importMapJson(obj);
  return { project, warnings, kind: "map" };
}

/** Parses + validates, then replaces the document. Throws (without touching state) on bad files. */
export async function loadProjectFile(file: File): Promise<void> {
  const { project, warnings, kind } = parseProjectFileText(await file.text());
  // Per-session id prefix: two people who open the same shared file mint
  // different ids from here on, so their floors merge back without collisions.
  // Existing ids keep their prefix (never renumbered). Map imports already mint
  // fresh via newProject(); autosave restore keeps the session's prefix.
  if (kind === "project") project.idPrefix = mintIdPrefix();
  docStore.replace(project);
  if (kind === "map") {
    editorStore.toast(
      "Rebuilt an editable project from exported map JSON — re-import each floor's plan image (traced geometry is kept)",
    );
  }
  for (const w of warnings.slice(0, 4)) editorStore.toast(w);
  if (warnings.length > 4) editorStore.toast(`…and ${warnings.length - 4} more warnings`);
}

export function downloadJson(filename: string, json: unknown): void {
  download(filename, new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
}
