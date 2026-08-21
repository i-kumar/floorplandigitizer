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
8. **Export (Ctrl/Cmd+E)** — validation warnings (disconnected nav network, orphan
   nodes, broken rooms, dangling links…) then download the map JSON.

## Sharing work

**Save (Ctrl/Cmd+S)** downloads `<building>.floorplan.json` with everything
embedded — plan images, walls, rooms, nav, links, calibration. Send that file to
anyone; they run the tool and **Open (Ctrl/Cmd+O)** it (drag-and-drop onto the
canvas also works). Autosave (IndexedDB) is per-browser and separate from these
files. Ids carry a random per-project prefix, so separately digitized floors and
buildings can be combined later without collisions.

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
| V / W / P / E / R / C | Select · Walls · Paths · POI · Room · Calibrate |
| D | Door mode (wall tool) |
| Right-click or Ctrl+Z (while drawing) | Remove last placed point (chain re-anchors; Ctrl+Shift+Z re-adds) |
| Esc / Enter / double-click | Finish the chain (segments are kept) |
| Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z | Undo · redo (snapshots, 20 deep) |
| Delete / Backspace | Delete selection (cascades cleanly: edges, links, rooms) |
| Space-drag / middle-drag · wheel | Pan · zoom to cursor |
| + / − / 0 | Zoom in / out / fit |
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
    "rooms": [{ "id": "x7k2-r1", "name": "Lobby",
                "polygon": [[0,0],[100,0],[100,100],[0,100]], "poiId": "x7k2-p2" }]
  }],
  "interFloorEdges": [
    { "from": ["x7k2-f1", "x7k2-n9"], "to": ["x7k2-f2", "x7k2-n1"],
      "kind": "escalator", "oneWay": true }
  ]
}
```

Notes for the consuming app:
- All coordinates are floor-image pixels, y-down. Real distance = pixels ÷ `pxPerMeter`.
- `kind` on edges/walls is an open string tag (`door`, `window`, `accessible`, …).
- Ids are stable and carry a random per-project prefix, so separately digitized
  buildings/floors never collide when merged.
- Treat `interFloorEdges` with `oneWay: true` as directed (escalators).

## Architecture (for future edits)

- `src/core/` is framework-free TS: `model.ts` (document + all mutations and their
  ripple rules), `snap.ts` (pure snapping engine), `rooms.ts` (half-edge face
  tracing), `store.ts` (undo snapshots + editor state), `tools.ts` (pointer state
  machines), `renderer.ts` (canvas), `export.ts`, `persist.ts`, `pdf.ts`.
- React (`src/ui/`) is chrome only; it subscribes via `useSyncExternalStore`.
- Walls and nav are the same node+edge `Graph` type — one drawing/snapping/editing
  toolset serves both; walls flatten to segments only at export.
