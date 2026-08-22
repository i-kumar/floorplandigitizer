# CLAUDE.md — Floor Plan Digitizer

Browser tool that digitizes building floor plans (PDF/image) into JSON for
Ishan's separate indoor-navigation app: wall vectors, a Dijkstra-ready nav
graph, POIs, and room polygons. `README.md` covers user-facing behavior and the
export schema; this file covers how to work on the code.

## Commands

```bash
npm run dev        # Vite dev server → http://localhost:5173
npm test           # vitest run (node env; tests are src/core/*.test.ts)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

Stack: React 18 + Vite + TypeScript (strict). Runtime deps are only react,
react-dom, pdfjs-dist. No state/canvas/id libraries — keep it that way.

## Architecture

`src/core/` is framework-free TS; `src/ui/` is React chrome only.

- `model.ts` — document types + ALL mutations and their ripple rules
- `geometry.ts` — pure math (projection, ray/segment, seg/seg, polygons)
- `snap.ts` — pure snapping engine (`snap(args) → SnapResult`)
- `rooms.ts` — half-edge face tracing (room detection + `outerBoundary` for the
  building outline)
- `hit.ts` — hit-testing for the Select tool
- `store.ts` — docStore (project + snapshot undo), editorStore (ephemeral),
  overlayStore (high-frequency: viewport/cursor/snap previews)
- `tools.ts` — Tool interface, input router, pan/zoom, all tool state machines,
  global actions (setTool/setFloor/performUndo/deleteSelection/fitView)
- `renderer.ts` — canvas drawing, rAF-coalesced, subscribes to all 3 stores
- `export.ts` — pure `buildExport(project) → { json, warnings }`
- `persist.ts` — IndexedDB autosave, .floorplan.json save/load, validateProject
- `pdf.ts` — pdfjs rasterization (worker via Vite `?url` import)
- `shortcuts.ts` — global keydown map (active tool gets first refusal)
- `colors.ts` — deterministic room/POI-type colors (renderer + dialogs)

UI: `CanvasView` (event normalization → router), `Toolbar`, `FloorPanel`
(+`applyFloorImage`), `Inspector`, `PdfImportDialog`, `ExportDialog`,
`PoiTypesDialog`, `StatusBar`, `hooks.ts` (`useDoc`/`useEditor`/`useOverlay`
via `useSyncExternalStore`, `useEscape` for dialogs).

## Invariants — violating these breaks undo, export, or navigation

1. **All document mutations go through docStore**: `transact(fn)` for clicks
   (one transact = one undo step), `beginGesture`/`mutate`/`endGesture` for
   drags. Never mutate `docStore.project` outside these; `fn` must be
   synchronous (do async work like PDF rendering BEFORE the transact).
2. **Use the layer wrappers, not raw graph ops**, whenever a floor is involved:
   walls → `splitWallEdge` / `mergeWallNodes` / `deleteWallNode` /
   `deleteWallEdge` (they patch room loops + `sweepRooms`); nav →
   `deleteNavNode` / `deleteNavEdge` / `mergeNavNodes` (they prune
   `interFloorEdges` + `poi.navNodeId`). Raw `splitEdge`/`mergeNodes`/... are
   for isolated graphs and tests.
3. **Edges are stored under canonical `edgeKey(a,b)`** — duplicates/self-edges
   are structurally impossible. Always insert via `addEdge` (or
   `addEdgeWithIntersections`, which also splits at crossings — the chain tool
   uses that one). Never write `g.edges[...]` directly outside model.ts.
4. **No degree-0 graph nodes** (except transiently as a chain's first point).
   Edge removals orphan-sweep endpoints. Lone points are POIs' job.
5. **Ids come from `newId(project, prefix)`** — they carry the project's random
   `idPrefix` so separately-created files merge without collisions
   (multi-person workflow). Exported ids must stay stable; never renumber.
6. **`floor.image` is immutable** — replace the whole object, never mutate it.
   `cloneProject` (undo snapshots) shares image refs by design; mutating one
   would corrupt history.
7. **Rooms reference wall node ids** (`room.loop`); polygons are resolved from
   current node coords at render/export. A room whose loop stops being a valid
   edge cycle is deleted by `sweepRooms`. Room ↔ its POI are a paired
   lifecycle (delete either → both). A POI and its linked nav node are
   independent (deleting one clears the link, never cascades).
   **`floor.outline` is looser**: an ordered ring of wall node ids picked with
   the Outline tool (O). Corners need NOT be joined by wall edges — validity is
   just ">= 3 existing nodes" (`sweepOutline`), which sidesteps the fragility
   of cycle detection on messy tracings. Same wall-wrapper patching (split
   inserts between adjacent corners, merge dedupes, deletes drop corners).
   Export normalizes its winding to room orientation. The OutlineTool commits
   nothing until the ring closes, so its step-back is pure local state.
   (`outerBoundary(walls)` — auto-detection via the most-negative traced face —
   still exists tested in rooms.ts but is deliberately NOT wired to any UI:
   the user found it buggy on real plans and chose manual picking.)
8. **Coordinates are floor-image pixels, y-down.** Snap/hit tolerances are
   screen px divided by zoom. `snap()` and `buildExport()` are pure — keep
   them that way; the tests depend on it.

## Behavioral contracts (user-requested; don't regress)

- **Ctrl+Z during a chain steps the chain back and re-anchors** — same code
  path as right-click (`ChainTool.stepBack` via `performUndo` →
  `activeTool().handleUndo`). Ctrl+Shift+Z re-advances. Esc ends a chain
  KEEPING segments; a single freshly-created degree-0 point is removed.
- Undo cap is 20 snapshots (user preference — keep caps conservative).
- `kind` on edges and `InterFloorEdge.oneWay` are open extension points; the
  consuming app treats `oneWay: true` as directed (escalators).
- POI types use a real `<select>` (+ "new type…" prompt) — datalists filter by
  the current text and hide options (user-reported bug; don't reintroduce for
  closed vocabularies).
- Drawn segments split at intersections with existing edges (both layers).
- Viewport navigation is Figma-style: plain scroll PANS, pinch (ctrlKey wheel)
  and ⌘+scroll zoom to cursor; H is a hand tool, Space/middle-drag still pan.
  Don't revert wheel to zoom-only — the user asked for pan-first navigation.
- Autosave: 500ms debounce + hard 2s ceiling + pagehide flush. A plain
  debounce starves under continuous editing and loses work on reload.

## Gotchas that already cost debugging time

- **Face tracing rotation**: successor of half-edge (u→v) is the PREVIOUS
  neighbor in angle-sorted order at v (`(idx - 1 + n) % n`). `+1` looks
  equally plausible, passes on degree-2 graphs, and merges adjacent rooms at
  degree-3 junctions — rooms.test.ts catches it.
- **Synchronous React flush**: `useSyncExternalStore` re-renders during the
  pointerdown listener, so a `focus()` in an effect gets stolen back by the
  canvas's default mousedown focus. Defer autofocus with `setTimeout(0)`
  (see `CommitInput.autoFocusNonce`).
- **pdf.ts must not be imported by anything vitest touches** (node env; the
  `?url` worker import and DOM canvas would fail). Only UI files import it.
- Canvas listeners: `wheel` must be non-passive + preventDefault; `contextmenu`
  preventDefault always (right-click = chain step-back); `setPointerCapture`
  on pointerdown; ignore non-primary pointers.
- Autosave storage is IndexedDB, not localStorage — embedded plan images blow
  the ~5MB localStorage quota.
- High-frequency state (cursor, snapPreview, viewport, hover) lives in
  `overlayStore` so per-mousemove updates don't re-render the whole chrome.
  Don't move those fields to editorStore.
- Rasterization is 300 DPI capped at 8000px long edge (`pdf.ts`). Coordinates
  are tied to raster dims, so changing these only affects NEW imports;
  `rescaleFloorGeometry` + the `applyFloorImage` confirm flow handle
  re-imports at different resolutions.

## Verification

- Unit tests cover the pure core only (geometry, snap priority/compositions,
  face tracing, model ripple rules, export warnings, undo). Add tests there
  for any new core behavior; renderer/tools/chrome are verified manually.
- For end-to-end checks, drive the real app: start `npm run dev`, then use
  playwright-core with the system Chrome
  (`executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`,
  no browser download needed). Pattern: click canvas coordinates to draw,
  auto-accept dialogs (`page.on("dialog", d => d.accept("10"))`), read the
  Export dialog's summary line for structural assertions, check
  `console`/`pageerror` events, and screenshot + actually look at it. A
  generated 2-page PDF (via `page.pdf()`) works for import tests. Wait ~1s
  before reload checks so autosave flushes.
