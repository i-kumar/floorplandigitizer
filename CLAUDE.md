# CLAUDE.md — Floor Plan Digitizer

Browser tool that digitizes building floor plans (PDF/image) into JSON for
Ishan's separate indoor-navigation app: wall vectors, a Dijkstra-ready nav
graph, POIs (doors as lines along walls), and room polygons. Built for an
organization-wide workflow: many people per building, buildings joined later by
a backend linker. `README.md` covers user-facing behavior, the team workflow,
the linker contract, and the export schema; this file covers how to work on the
code.

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

- `model.ts` — document types + ALL mutations and their ripple rules (walls ↔
  rooms/outline/door spans, nav ↔ links/POI refs), door creation
  (`createDoorPoi`, `insertDoorOnEdge`), `buildingSlug`, `mintIdPrefix`
- `vocab.ts` — the ONE closed type list (`POI_TYPES`; a room is a POI with an
  area, type defaults to "room" but can be stairs/escalator/…), door
  `POI_ACCESS` values, `EXTERNAL_LINK_KINDS`; `typeOptionsFor(poi)` filters the
  list by context (no "door" for rooms, no "room" for lone points). Changing the
  org vocabulary = edit here + redeploy.
- `geometry.ts` — pure math (projection, ray/segment, seg/seg, polygons)
- `snap.ts` — pure snapping engine (`snap(args) → SnapResult`)
- `rooms.ts` — half-edge face tracing (room detection + `outerBoundary` for the
  building outline)
- `hit.ts` — hit-testing for the Select tool (door POIs hit along their line)
- `store.ts` — docStore (project + snapshot undo), editorStore (ephemeral),
  overlayStore (high-frequency: viewport/cursor/snap previews/door draft)
- `tools.ts` — Tool interface, input router, pan/zoom, all tool state machines
  (Select, Chain×2, POI, Door, Room, Outline, Calibrate), global actions
  (setTool/setFloor/performUndo/deleteSelection/fitView)
- `renderer.ts` — canvas drawing, rAF-coalesced, subscribes to all 3 stores
- `export.ts` — pure `buildExport(project) → { json, warnings }`; `schemaVersion: 2`
- `persist.ts` — IndexedDB autosave, .floorplan.json save/load, validateProject
  (repairs/strips unknown shapes, never rejects old fields), `parseProjectFileText`
  (dispatches project files vs exported map JSON), `loadProjectFile` (re-mints
  the session id prefix)
- `interchange.ts` — `importMapJson` (rebuild an editable Project from exported
  map JSON: welds wall segments back into shared nodes by rounded coords,
  re-matches door `line`s and room polygons onto them, preserves nav/POI/room
  ids, mints wall ids under a fresh prefix, records `floor.expectedImageSize`),
  `mergePreview` (rows for the MergeDialog) and `mergeProjectInto(target,
  source, { floorIds })` (replace same-id floors in place / append new ones;
  validates id collisions BEFORE mutating, so it's transact-safe)
- `pdf.ts` — pdfjs rasterization (worker via Vite `?url` import)
- `shortcuts.ts` — global keydown map (active tool gets first refusal)
- `colors.ts` — vocabulary colors + deterministic fallback (renderer + dialogs)

UI: `CanvasView` (event normalization → router), `Toolbar` (tools, building
name + **building id** slug), `FloorPanel` (+`applyFloorImage`, opens
`MergeDialog`), `MergeDialog` (per-floor new/replace preview + checkboxes),
`Inspector` (incl. door access, "Other building" external link, Edge inspector
"Add door POI"), `PdfImportDialog`, `ExportDialog`, `StatusBar`, `hooks.ts`
(`useDoc`/`useEditor`/`useOverlay` via `useSyncExternalStore`, `useEscape` for
dialogs).

## Invariants — violating these breaks undo, export, merge, or navigation

1. **All document mutations go through docStore**: `transact(fn)` for clicks
   (one transact = one undo step), `beginGesture`/`mutate`/`endGesture` for
   drags. Never mutate `docStore.project` outside these; `fn` must be
   synchronous (do async work like PDF rendering BEFORE the transact).
2. **Use the layer wrappers, not raw graph ops**, whenever a floor is involved:
   walls → `splitWallEdge` / `mergeWallNodes` / `deleteWallNode` /
   `deleteWallEdge` / **`moveWallNode`** (they patch room loops, the outline,
   and door spans, then `sweepRooms` + `syncDoorPois`); nav → `deleteNavNode` /
   `deleteNavEdge` / `mergeNavNodes` (they prune `interFloorEdges` +
   `poi.navNodeId`). Never write a wall node's `x/y` directly — door POIs would
   drift off their wall. Raw `splitEdge`/`mergeNodes`/... are for isolated
   graphs and tests.
3. **Edges are stored under canonical `edgeKey(a,b)`** — duplicates/self-edges
   are structurally impossible. Always insert via `addEdge` (or
   `addEdgeWithIntersections`, which also splits at crossings and returns the
   node chain — the chain tool uses that one, and door mode hands the chain to
   `createDoorPoi`). Never write `g.edges[...]` directly outside model.ts.
4. **No degree-0 graph nodes** (except transiently as a chain's first point).
   Edge removals orphan-sweep endpoints. Lone points are POIs' job.
5. **Ids come from `newId(project, prefix)`** — they carry `idPrefix`, a 6-char
   random prefix minted per *editing session*: `newProject()` and every file
   **Open** (`loadProjectFile`) re-mint it, autosave restore and merge sources
   don't. That is what lets several people fork the lead's shared building file
   and merge back without collisions. Exported ids must stay stable; never
   renumber. `Project.buildingId` (slug) is the building's identity across
   files and for the linker — never auto-change it once set.
6. **`floor.image` is immutable** — replace the whole object, never mutate it.
   `cloneProject` (undo snapshots) shares image refs by design; mutating one
   would corrupt history. Everything else (incl. `poi.span`, `poi.externalLink`)
   must be deep-copied there — in-place `splice`s on a shared array corrupt
   every snapshot.
7. **Rooms reference wall node ids** (`room.loop`); polygons are resolved from
   current node coords at render/export. A room whose loop stops being a valid
   edge cycle is deleted by `sweepRooms`. Room ↔ its POI are a paired
   lifecycle (delete either → both). A POI and its linked nav node are
   independent (deleting one clears the link, never cascades).
   **`floor.outline` is looser**: an ordered ring of wall node ids picked with
   the Outline tool (O). Corners need NOT be joined by wall edges — validity is
   just ">= 3 existing nodes" (`sweepOutline`). Same wall-wrapper patching.
   Export normalizes its winding to room orientation. (`outerBoundary(walls)`
   auto-detection exists tested in rooms.ts but is deliberately NOT wired to
   any UI: the user found it buggy on real plans and chose manual picking.)
   **Doors are `poi.span`**: an ordered open path of wall node ids (>= 2, no
   repeats) whose consecutive pairs are wall edges tagged `kind:"door"`
   (`pathEdgesValid`). Exactly one POI per door; `poi.x/y` is STORED and kept at
   the midpoint of the span's end nodes by `syncDoorPois` (so snap/hit/export
   read x/y as usual — never recompute+round it at export, the import round-trip
   depends on the stored value). Wrappers patch spans like loops (`patchPathOnSplit`
   has no wrap-around pair; `dedupePath` never collapses first/last). An invalid
   span **degrades the POI to a point** (span removed, everything else kept) —
   it is never deleted by a wall edit; export warns so it gets redrawn. A spanned
   POI is not draggable in Select; its extent moves with its wall nodes.
8. **Coordinates are floor-image pixels, y-down.** Snap/hit tolerances are
   screen px divided by zoom. `snap()` and `buildExport()` are pure — keep
   them that way; the tests depend on it.
9. **The vocabulary is closed and single** (`vocab.ts`; user decision: no
   separate room types — a room is "room" or any other POI type). Legacy values on loaded files are
   preserved (shown as "(legacy) x", export warns) — never rewrite a POI's type
   on load. `Project.version` stays 1: every new field is optional and
   `validateProject` strips/repairs rather than rejects.

## Behavioral contracts (user-requested; don't regress)

- **Ctrl+Z during a chain steps the chain back and re-anchors** — same code
  path as right-click (`ChainTool.stepBack` via `performUndo` →
  `activeTool().handleUndo`). Ctrl+Shift+Z re-advances. Esc ends a chain
  KEEPING segments; a single freshly-created degree-0 point is removed. A
  door-mode segment and its auto-created POI are one transaction, so step-back
  reverts both.
- **One way to make a door** (`createDoorPoi`): Wall-tool door mode, the Door
  tool (two clicks on one wall → `insertDoorOnEdge`; one click on a door edge
  → attach), and the Edge inspector's "Add door POI" all go through it.
- **D** selects the Door tool everywhere except inside the Wall tool, where the
  chain tool consumes it as the door-segment toggle (tool-first refusal).
- Undo cap is 20 snapshots (user preference — keep caps conservative).
- `kind` on edges, `InterFloorEdge.oneWay`, `poi.access`, and
  `externalLink.kind` are open extension points; the consuming app treats
  `oneWay: true` as directed (escalators) and unknown `access` as restricted.
- POI/room types use a real `<select>` over the vocabulary — datalists filter
  by the current text and hide options (user-reported bug; don't reintroduce
  for closed vocabularies). No per-project type editing.
- Drawn segments split at intersections with existing edges (both layers).
- Viewport navigation is Figma-style: plain scroll PANS, pinch (ctrlKey wheel)
  and ⌘+scroll zoom to cursor; H is a hand tool, Space/middle-drag still pan.
  Don't revert wheel to zoom-only — the user asked for pan-first navigation.
- Autosave: 500ms debounce + hard 2s ceiling + pagehide flush. A plain
  debounce starves under continuous editing and loses work on reload.
- **Merge is replace-by-floor-id with a preview** (`MergeDialog`): empty source
  floors default unchecked, same-id floors keep their list position, links
  survive when both nav nodes still exist, a different `buildingId` is flagged
  (buildings link, they don't merge). Keep it one undo step.
- Export is `schemaVersion: 2`; bump it when the shape changes and keep
  `importMapJson` accepting older versions.

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
  `persist.ts` is safe to import in tests (no DOM at module load).
- Canvas listeners: `wheel` must be non-passive + preventDefault; `contextmenu`
  preventDefault always (right-click = chain step-back / door un-arm);
  `setPointerCapture` on pointerdown; ignore non-primary pointers.
- Autosave storage is IndexedDB, not localStorage — embedded plan images blow
  the ~5MB localStorage quota.
- High-frequency state (cursor, snapPreview, viewport, hover, doorDraft) lives
  in `overlayStore` so per-mousemove updates don't re-render the whole chrome.
  Don't move those fields to editorStore.
- Rasterization is 300 DPI capped at 8000px long edge (`pdf.ts`). Coordinates
  are tied to raster dims, so changing these only affects NEW imports;
  `rescaleFloorGeometry` + the `applyFloorImage` confirm flow handle
  re-imports at different resolutions. `applyFloorImage` compares against
  `floor.image ?? floor.expectedImageSize` — the latter is set by map-JSON
  recovery (which has no images) and cleared once an image lands.
- Export→import round-trip is a tested fixed point (interchange.test.ts):
  keep nav/POI/room ids, door `line`s, and coordinate rounding stable or
  recovery breaks. Any new exported POI field must be read back in
  `importMapJson` too, or the fixed-point test fails.
- `deleteNodeCascade` orphan-sweeps neighbors: deleting a nav node also removes
  a degree-1 neighbor, which is why a merge test that "keeps" a link must leave
  the linked node another edge.
- Door-tool first click on a *node* is ambiguous (several incident edges): the
  edge is re-resolved on every move as the one nearest the cursor, not fixed at
  click time (all incident edges are at distance 0 at the node itself).

## Verification

- Unit tests cover the pure core only (geometry, snap priority/compositions,
  face tracing, model ripple rules incl. door spans, export warnings, map-JSON
  round-trip, merge preview/replace, validateProject repairs, undo). Add tests
  there for any new core behavior; renderer/tools/chrome are verified manually.
- For end-to-end checks, drive the real app: start `npm run dev`, then use
  playwright-core with the system Chrome
  (`executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`,
  no browser download needed). Pattern: click canvas coordinates to draw,
  auto-accept dialogs (`page.on("dialog", d => d.accept("10"))`), read the
  Export dialog's summary line for structural assertions, check
  `console`/`pageerror` events, and screenshot + actually look at it. A
  generated 2-page PDF (via `page.pdf()`) works for import tests. Wait ~1s
  before reload checks so autosave flushes. For merge flows, capture Save's
  download (`page.waitForEvent("download")`) and feed it back through the
  hidden file inputs with `setInputFiles`.
