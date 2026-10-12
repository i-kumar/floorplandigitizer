# Floor Plan Digitizer

A browser-based graphical tool that converts building floor plans (PDF or image)
into structured map data for an indoor-navigation app:

1. **Wall vectors** — line segments with start/end coordinates (doors tagged with
   `kind: "door"`), so the app can render floors as crisp vector maps instead of PNGs.
2. **A walkable nav network** — nodes + edges ready for Dijkstra/A*, connected
   across floors by stairs/elevator/escalator links (escalators can be one-way).
3. **POIs, doors, and rooms** — typed points from a fixed org-wide vocabulary,
   **doors as lines along their wall** (one POI each, optionally emergency-only,
   optionally the connection to another building), and room polygons detected
   from closed wall cycles, each room owning a POI. Nav nodes can be linked to
   POIs so navigation can end at "the vending machine" or "Room 204".
4. **A building outline** per floor — the footprint polygon, drawn by clicking
   the perimeter's wall corners, for drawing the building on a zoomed-out map
   without the full plan.

Everything is client-side. Projects autosave to IndexedDB and can be saved/loaded
as `.floorplan.json` files (plan images embedded).

**Hosted copy:** https://www.maizebus.com/floorplantool/ — use this if you just
want to digitize plans; nothing to install. It is deployed from the
`maizebus-web` repository, where this repo is a git submodule, and the URL is
unlisted on purpose (internal tool) — share it directly. The rest of this
section is for running the tool locally.

## Run it

Fresh clone, macOS/Linux — one command installs Node (via nvm, if missing) and
the packages, then checks the install:

```bash
./setup.sh          # or ./setup.sh --dev to start the app right away
```

Windows: install Node LTS from <https://nodejs.org>, then `npm install`.

Day to day:

```bash
npm run dev      # → http://localhost:5173
npm test         # unit tests (geometry, snapping, rooms, model, export, merge, undo)
npm run build    # type-check + production build
```

## Workflow

1. **Name the building** — the toolbar's name box, plus the **building id** next
   to it (a stable slug like `science-hall`, auto-filled from the name the first
   time). Everyone working on this building uses the same id; the linker joins
   buildings by it.
2. **Import a plan** — Floors panel → *Import plan*, or drag a PDF/PNG onto the
   canvas. PDFs open a page picker: use one page for the current floor, or create
   one floor per page. Pages rasterize at **300 DPI** (capped at an 8000px long
   edge for huge sheets); all coordinates are in that image's pixel space.
   Replacing a floor's image with different dimensions offers to **scale the
   traced geometry proportionally** — the right choice when re-importing the same
   plan at a higher resolution.
3. **Calibrate (C)** — click two points a known distance apart and enter the real
   length in meters. Stores `pxPerMeter` per floor (edge weights & consistent
   cross-floor scale).
4. **Trace walls (W)** — click-click chained lines. Press **D** to toggle *door
   mode*: those segments get `kind: "door"`, render as openings, **close the wall
   cycle so rooms can be detected**, and each one **gets its door POI
   automatically**. A drawn segment that **crosses existing lines gets a shared
   node at every intersection** (both segments split) — on the nav layer too, so
   crossing corridors connect.
5. **Mark doors (D)** — for walls traced straight through a doorway: click where
   the door starts on the wall, then where it ends. The wall is split at both
   points, the piece between becomes a door edge, and its single POI is created
   (a door is a *line along its wall*, not a point). One click on an existing
   door segment attaches a POI to it (legacy door edges also offer *Add door POI*
   in the Edge inspector). In the Inspector set the door's **access** — *Normal*
   or *Emergency exit only*. A door's extent follows its wall nodes: drag those
   (Walls layer) to resize it. If a wall edit breaks the span the POI survives as
   a point and export tells you to redraw it.
6. **Make rooms (R)** — hover an enclosed region (highlight preview), click to
   create the room + its centroid POI, type its name (the name box is focused
   and selected, so you can type room numbers back to back). A room is just a
   POI with an area: its type defaults to `room` but can be any POI type
   (stairs, escalator, restroom_female, …) from the same list. Type **solid**
   marks a block that should be drawn as filled-in wall (pillars, shafts) — it
   renders opaque on the canvas and exports as `rooms[].type: "solid"`.
7. **Place POIs (E)** — click to drop; pick type/name in the Inspector. Types are
   a **fixed list** (`src/core/vocab.ts`) so every plan in the organization uses
   the same vocabulary; POIs are color-coded by type on the canvas. Placement
   snaps to walls.
8. **Draw the nav network (P)** — same chained drawing on the nav layer. Clicking
   a POI (a door's midpoint included) drops a nav node **linked to it**
   (`poi.navNodeId`), making it routable.
9. **Link floors** — select a nav node (V), Inspector → *Link to another floor…*
   (stairs / elevator / escalator, one-way toggle), switch floors (1–9), click the
   target nav node.
10. **Draw the outline (O)** — click the building's corner nodes in order
    (snapped to wall nodes; corners need *not* be joined by wall edges, so you can
    skip along straight runs and wall-graph gaps don't matter). Click the first
    corner again — or press Enter — to close; right-click/Ctrl+Z un-picks; Esc
    cancels. Rendered as a halo stroke. Corners reference wall nodes, so the
    outline follows wall edits; it clears itself if it drops below 3 existing
    corners. *Clear* in the Floors panel removes it; drawing again replaces it.
11. **Export (Ctrl/Cmd+E)** — validation warnings (disconnected nav network,
    orphan nodes, point doors, unknown types, incomplete building links, broken
    rooms or outline…) then download the map JSON.

## Working as a team on one building

One project file = one building. The workflow the tool is built around:

1. **Lead:** New project → set the building **name** and **id** → add and name
   every floor (Floors panel) → **Save** `<building>.floorplan.json` → share it.
2. **Each contributor:** **Open** the shared file (Ctrl/Cmd+O or drag-and-drop),
   import the plan for their floor(s), trace, and **Save** their own copy. Opening
   a file mints a fresh per-session id prefix, so two people forking the same file
   never create colliding ids — and existing ids are never renumbered, so the nav
   app's ids stay stable across revisions.
3. **Integrator:** Open the lead file (or any contributor's), then Floors panel →
   ***Add floors from another file…*** for each contributor's file. The dialog
   lists every floor in that file as **new** or **replaces "X"** with wall/nav/POI
   counts on both sides; floors already in the project are **replaced in place**
   (same position in the list), empty ones are unchecked by default so an
   untouched floor never wipes a finished one. Then draw the stairs/elevator
   links between floors and export.
4. **Revisions:** when a contributor sends an updated file, run the same merge —
   their floor is replaced again, and inter-floor links whose nav nodes still exist
   are kept (the dialog's toast reports any that were dropped). Edits the
   integrator made *on that floor* are overwritten: the floor's owner is the
   source of truth; project-level work (links, other floors) is untouched.

The merge also accepts an exported `.map.json` (it rebuilds the floors from it,
keeping an already-attached plan image when the raster size matches). A file for
a *different* building id is flagged in the dialog — buildings don't merge, they
link (next section).

**Save vs. autosave:** Save (Ctrl/Cmd+S) downloads the project file with
everything embedded — plan images, walls, doors, rooms, nav, links, calibration.
Autosave (IndexedDB) is per-browser and separate from these files.

**Lost the project file but kept an export?** Open accepts an exported
`.map.json` too: it rebuilds an editable project from it — walls (endpoints
welded back into shared nodes), door spans, nav graph with its original ids, POIs
and their links, rooms, outlines, and calibration all survive; only the plan
images are missing (re-import each floor's PDF/image — the panel shows the raster
size it was traced on, and a mismatched size offers a proportional rescale).

## Linking buildings

Buildings are separate maps joined later by a **linker** (a backend step, not
this tool). To make a connection linkable, the two people responsible for the
two sides agree on a **key** and each mark their side:

1. Make the connecting door a real door (Door tool) with a nav node on it (Path
   tool click).
2. Inspector → *Other building* → **Connects to another building…**, then enter
   the **other** building's id, the shared key (unique per building pair, e.g.
   `bridge-2f`, `tunnel-b1`), and the kind (`door`, `bridge`, `tunnel`, `path`).
3. Export. The POI carries `externalLink`, and the top-level `externalLinks`
   index lists every linked POI that has a nav node. Export warns about
   incomplete links, links without a nav node, duplicate keys, and links that
   point at the map's own building (use an inter-floor link for those).

**Linker contract.** Given a set of exported maps: for every entry `L` in map
A's `externalLinks`, find the map B with `B.buildingId === L.building`, and in
B's `externalLinks` the entry `M` with `M.building === A.buildingId` and
`M.key === L.key`. Add an undirected edge between nav node `(A.buildingId,
L.floor, L.navNode)` and `(B.buildingId, M.floor, M.navNode)` tagged with
`L.kind` (both sides should agree; default `door`). An entry with no partner, or
more than one, is an error to report — keys must be unique per building pair.
Within one building, floors are joined by `interFloorEdges`, not by this
mechanism.

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
| V / H / W / P / E / D / R / O / C | Select · Pan · Walls · Paths · POI · Door · Room · Outline · Calibrate |
| D (while in the Wall tool) | Door mode toggle (next segments become doors with their POIs) |
| Right-click or Ctrl+Z (while drawing) | Remove last placed point (chain re-anchors; Ctrl+Shift+Z re-adds); un-arms a half-placed door |
| Esc / Enter / double-click | Finish the chain (segments are kept); Esc also closes dialogs, cancels linking/calibration/door placement, clears selection |
| Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z (or Ctrl+Y) | Undo · redo (snapshots, 20 deep) |
| Delete / Backspace | Delete selection (cascades cleanly: edges, links, rooms; doors degrade to points) |
| Scroll · Space-drag · middle-drag · H-drag | Pan |
| Pinch · ⌘+scroll · + / − · 0 | Zoom to cursor / in / out / fit |
| 1–9 | Switch floor |
| Ctrl/Cmd+S / O / E | Save project · open project · export |

## Export schema

```jsonc
{
  "schemaVersion": 2,              // absent in older files (= 1)
  "building": "Science Hall",
  "buildingId": "science-hall",    // stable slug; "" if never set
  "floors": [{
    "id": "x7k2a1-f1", "name": "Floor 1",
    "pxPerMeter": 42.3,            // null if uncalibrated
    "width": 3000, "height": 2318, // plan image extents
    "walls": [{ "start": [120, 80], "end": [560, 80], "kind": "door" }],
    "nav": {
      "nodes": [{ "id": "x7k2a1-n1", "x": 140, "y": 210 }],
      "edges": [{ "from": "x7k2a1-n1", "to": "x7k2a1-n2", "kind": "accessible" }]
    },
    "pois": [
      { "id": "x7k2a1-p1", "x": 300, "y": 95, "type": "drinking_fountain",
        "name": "Fountain by gym", "navNodeId": "x7k2a1-n1" },
      { "id": "x7k2a1-p4", "x": 340, "y": 80, "type": "door", "name": "East door",
        "line": [[120, 80], [560, 80]],        // the door's extent along its wall
        "access": "emergency_only",            // absent = normal door
        "navNodeId": "x7k2a1-n7",
        "externalLink": { "building": "library", "key": "bridge-2f", "kind": "bridge" } }
    ],
    "rooms": [{ "id": "x7k2a1-r1", "name": "Lobby", "type": "room",
                "polygon": [[0,0],[100,0],[100,100],[0,100]], "poiId": "x7k2a1-p2" }],
    "outline": [[0,0],[560,0],[560,410],[300,410],[300,560],[0,560]]
  }],
  "interFloorEdges": [
    { "from": ["x7k2a1-f1", "x7k2a1-n9"], "to": ["x7k2a1-f2", "x7k2a1-n1"],
      "kind": "escalator", "oneWay": true }
  ],
  "externalLinks": [               // index of pois[].externalLink entries that have a nav node
    { "floor": "x7k2a1-f1", "poi": "x7k2a1-p4", "navNode": "x7k2a1-n7",
      "building": "library", "key": "bridge-2f", "kind": "bridge" }
  ]
}
```

Notes for the consuming app:
- All coordinates are floor-image pixels, y-down. Real distance = pixels ÷ `pxPerMeter`.
- `width`/`height` are `null` for floors that have no plan image.
- Doors are POIs of type `door` with a `line` (≥ 2 points along the wall, which
  also appears in `walls` tagged `kind: "door"`); `x`/`y` is the line's midpoint.
  A door without `line` is a legacy point door (export warns). `access` is an
  open enum — today only `emergency_only`; treat unknown values as restricted.
- POI `type` (and therefore `rooms[].type`) comes from the single fixed list in
  `src/core/vocab.ts` (room, solid, door, entrance, stairs, elevator, escalator,
  restroom_male, restroom_female, restroom_neutral, drinking_fountain,
  vending_machine, food, printer, info_desk, other). Values
  outside it only appear in files from older versions.
- `outline` is the floor's footprint polygon for zoomed-out rendering (`null` if
  never drawn); winding is normalized to match room polygons regardless of the
  order the corners were clicked. Pick one floor's outline (e.g. the ground
  floor) to represent the whole building on a map.
- `kind` on edges/walls is an open string tag (`door`, `window`, `accessible`, …).
- `rooms[].type` mirrors the room-POI's type (`"room"` unless changed in the
  room inspector) — no need to join through `poiId` for it. `"solid"` means
  "draw this polygon as filled-in wall" (not a navigable space).
- Ids are stable and carry a random per-session prefix, so separately digitized
  buildings/floors never collide when merged; never renumber them.
- Treat `interFloorEdges` with `oneWay: true` as directed (escalators).
- `externalLinks` / `buildingId` are for the cross-building linker (above).

## Architecture (for future edits)

- `src/core/` is framework-free TS: `model.ts` (document + all mutations and their
  ripple rules, incl. door spans), `vocab.ts` (the fixed POI/room type lists),
  `snap.ts` (pure snapping engine), `rooms.ts` (half-edge face tracing),
  `store.ts` (undo snapshots + editor state), `tools.ts` (pointer state
  machines), `renderer.ts` (canvas), `geometry.ts`, `hit.ts`, `export.ts`,
  `interchange.ts` (map-JSON recovery + merge), `persist.ts`, `pdf.ts`,
  `shortcuts.ts`, `colors.ts`.
- React (`src/ui/`) is chrome only; it subscribes via `useSyncExternalStore`.
- Walls and nav are the same node+edge `Graph` type — one drawing/snapping/editing
  toolset serves both; walls flatten to segments only at export.
- See `CLAUDE.md` for editing conventions, invariants, and gotchas.
