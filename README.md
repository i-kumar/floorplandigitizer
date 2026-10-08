# Floor Plan Digitizer

A browser-based graphical tool that converts building floor plans (PDF or image)
into structured map data for an indoor-navigation app:

1. **Wall vectors** — line segments with start/end coordinates (doors tagged with
   `kind: "door"`), so the app can render floors as crisp vector maps instead of PNGs.
2. **A walkable nav network** — nodes + edges ready for Dijkstra/A*, connected
   across floors by stairs/elevator/escalator links (escalators can be one-way).
3. **POIs and rooms** — typed points ("drinking_fountain", "door", …) and room
   polygons detected from closed wall cycles, each room owning a POI. Nav nodes can
   be linked to POIs so navigation can end at "the vending machine" or "Room 204".
4. **A building outline** per floor — the footprint polygon, drawn by clicking
   the perimeter's wall corners, for drawing the building on a zoomed-out map
   without the full plan.

Everything is client-side. Projects autosave to IndexedDB and can be saved/loaded
as `.floorplan.json` files (plan images embedded).

## Run it

```bash
npm install
npm run dev      # → http://localhost:5173
npm test         # unit tests (geometry, snapping, rooms, model, export, undo)
npm run build    # type-check + production build
```

## Workflow

1. **Import a plan** — Floors panel → *Import plan*, or drag a PDF/PNG onto the
   canvas. PDFs open a page picker: use one page for the current floor, or create
   one floor per page. Pages rasterize at **300 DPI** (capped at an 8000px long
   edge for huge sheets); all coordinates are in that image's pixel space.
   Replacing a floor's image with different dimensions offers to **scale the
   traced geometry proportionally** — the right choice when re-importing the same
   plan at a higher resolution.
2. **Calibrate (C)** — click two points a known distance apart and enter the real
   length in meters. Stores `pxPerMeter` per floor (edge weights & consistent
   cross-floor scale).
3. **Trace walls (W)** — click-click chained lines. Press **D** to toggle *door
   mode*: those segments get `kind: "door"`, render as openings, and **close the
   wall cycle so rooms can be detected**. A drawn segment that **crosses existing
   lines gets a shared node at every intersection** (both segments split) — on
   the nav layer too, so crossing corridors connect.
4. **Make rooms (R)** — hover an enclosed region (highlight preview), click to
   create the room + its centroid POI, type its name. The room's POI type
   defaults to `room` but can be changed (classroom, bathroom, …) right in the
   room inspector.
5. **Place POIs (E)** — click to drop; pick type/name in the Inspector (the type
   dropdown always shows every type; "＋ new type…" adds one). POIs are
   **color-coded by type** on the canvas. Placement snaps to walls, so door-POIs
   land exactly on door edges.
6. **Draw the nav network (P)** — same chained drawing on the nav layer. Clicking
   a POI drops a nav node **linked to it** (`poi.navNodeId`), making it routable.
7. **Link floors** — select a nav node (V), Inspector → *Link to another floor…*
   (stairs / elevator / escalator, one-way toggle), switch floors (1–9), click the
   target nav node.
8. **Draw the outline (O)** — click the building's corner nodes in order
   (snapped to wall nodes; corners need *not* be joined by wall edges, so you can
   skip along straight runs and wall-graph gaps don't matter). Click the first
   corner again — or press Enter — to close; right-click/Ctrl+Z un-picks; Esc
   cancels. Rendered as a halo stroke. Corners reference wall nodes, so the
   outline follows wall edits; it clears itself if it drops below 3 existing
   corners. *Clear* in the Floors panel removes it; drawing again replaces it.
9. **Export (Ctrl/Cmd+E)** — validation warnings (disconnected nav network, orphan
   nodes, broken rooms or outline, dangling links…) then download the map JSON.

## Sharing, recovery, and merging

**Save (Ctrl/Cmd+S)** downloads `<building>.floorplan.json` with everything
embedded — plan images, walls, rooms, nav, links, calibration. Send that file to
anyone; they run the tool and **Open (Ctrl/Cmd+O)** it (drag-and-drop onto the
canvas also works). Autosave (IndexedDB) is per-browser and separate from these
files.

**Lost the project file but kept an export?** Open accepts an exported
`.map.json` too: it rebuilds an editable project from it — walls (endpoints
welded back into shared nodes), nav graph with its original ids, POIs and their
links, rooms, outlines, and calibration all survive; only the plan images are
missing (re-import each floor's PDF/image — the panel shows the raster size it
was traced on, and a mismatched size offers a proportional rescale).

**Floors panel → *Add floors from another file…*** appends every floor from a
second `.floorplan.json` or `.map.json` into the current project (with its POIs,
rooms, images, and internal links) — for adding a separately digitized floor or
combining two people's work. Ids carry a random per-project prefix, so distinct
files never collide; connect the new floors with stairs/elevator/escalator links
afterwards.

## Snapping

- **Nodes** (strongest), **POIs** (path tool), **on-segment** (clicking splits the
  edge — walls tee cleanly), then **angle** (45°/90° from the previous point).
- Angle-locked drawing composes with geometry: terminate exactly on a node that
  lies on the ray, split an edge at the exact ray intersection, or stop square
  with a nearby node (dashed alignment tie).
- **Shift** forces the angle lock · **Alt** disables snapping.
- Tolerances are in screen pixels — zoom in for precision.

## Keyboard

| Key | Action |
|---|---|
| V / H / W / P / E / R / O / C | Select · Pan · Walls · Paths · POI · Room · Outline · Calibrate |
| D | Door mode (wall tool) |
| Right-click or Ctrl+Z (while drawing) | Remove last placed point (chain re-anchors; Ctrl+Shift+Z re-adds) |
| Esc / Enter / double-click | Finish the chain (segments are kept); Esc also closes dialogs, cancels linking/calibration, clears selection |
| Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z (or Ctrl+Y) | Undo · redo (snapshots, 20 deep) |
| Delete / Backspace | Delete selection (cascades cleanly: edges, links, rooms) |
| Scroll · Space-drag · middle-drag · H-drag | Pan |
| Pinch · ⌘+scroll · + / − · 0 | Zoom to cursor / in / out / fit |
| 1–9 | Switch floor |
| Ctrl/Cmd+S / O / E | Save project · open project · export |

## Export schema

```jsonc
{
  "building": "Science Hall",
  "floors": [{
    "id": "x7k2-f1", "name": "Floor 1",
    "pxPerMeter": 42.3,            // null if uncalibrated
    "width": 3000, "height": 2318, // plan image extents
    "walls": [{ "start": [120, 80], "end": [560, 80], "kind": "door" }],
    "nav": {
      "nodes": [{ "id": "x7k2-n1", "x": 140, "y": 210 }],
      "edges": [{ "from": "x7k2-n1", "to": "x7k2-n2", "kind": "accessible" }]
    },
    "pois": [{ "id": "x7k2-p1", "x": 300, "y": 95, "type": "drinking_fountain",
               "name": "Fountain by gym", "navNodeId": "x7k2-n1" }],
    "rooms": [{ "id": "x7k2-r1", "name": "Lobby", "type": "classroom",
                "polygon": [[0,0],[100,0],[100,100],[0,100]], "poiId": "x7k2-p2" }],
    "outline": [[0,0],[560,0],[560,410],[300,410],[300,560],[0,560]]
  }],
  "interFloorEdges": [
    { "from": ["x7k2-f1", "x7k2-n9"], "to": ["x7k2-f2", "x7k2-n1"],
      "kind": "escalator", "oneWay": true }
  ]
}
```

Notes for the consuming app:
- All coordinates are floor-image pixels, y-down. Real distance = pixels ÷ `pxPerMeter`.
- `width`/`height` are `null` for floors that have no plan image.
- `outline` is the floor's footprint polygon for zoomed-out rendering (`null` if
  never drawn); winding is normalized to match room polygons regardless of the
  order the corners were clicked. Pick one floor's outline (e.g. the ground
  floor) to represent the whole building on a map.
- `kind` on edges/walls is an open string tag (`door`, `window`, `accessible`, …).
- `rooms[].type` mirrors the room-POI's type (`"room"` unless changed in the
  room inspector) — no need to join through `poiId` for it.
- Ids are stable and carry a random per-project prefix, so separately digitized
  buildings/floors never collide when merged.
- Treat `interFloorEdges` with `oneWay: true` as directed (escalators).

## Architecture (for future edits)

- `src/core/` is framework-free TS: `model.ts` (document + all mutations and their
  ripple rules), `snap.ts` (pure snapping engine), `rooms.ts` (half-edge face
  tracing), `store.ts` (undo snapshots + editor state), `tools.ts` (pointer state
  machines), `renderer.ts` (canvas), `geometry.ts`, `hit.ts`, `export.ts`,
  `persist.ts`, `pdf.ts`, `shortcuts.ts`, `colors.ts`.
- React (`src/ui/`) is chrome only; it subscribes via `useSyncExternalStore`.
- Walls and nav are the same node+edge `Graph` type — one drawing/snapping/editing
  toolset serves both; walls flatten to segments only at export.
- See `CLAUDE.md` for editing conventions, invariants, and gotchas.
