// Contextual properties for the current selection: node coords + inter-floor
// links, edge kinds, POI type/name/links, room name/area.
import { useEffect, useRef, useState } from "react";
import { docStore, editorStore, type ItemRef } from "../core/store";
import { deleteSelection } from "../core/tools";
import * as M from "../core/model";
import { dist, polygonSignedArea } from "../core/geometry";
import { useDoc, useEditor } from "./hooks";

/** Text input that keeps local state and commits on blur/Enter. */
function CommitInput({
  value,
  onCommit,
  placeholder,
  list,
  autoFocusNonce,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  list?: string;
  autoFocusNonce?: number;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (!autoFocusNonce) return;
    // Defer past the canvas click's default action, which would otherwise
    // steal focus straight back to the canvas.
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [autoFocusNonce]);
  return (
    <input
      ref={ref}
      value={text}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Real dropdown for POI types (a datalist filters by the current text, hiding
 *  the other options). "＋ new type…" prompts and adds to the project list. */
function PoiTypeSelect({ value, onCommit }: { value: string; onCommit: (t: string) => void }) {
  const doc = useDoc();
  const NEW = "__new__";
  const options = doc.poiTypes.includes(value) ? doc.poiTypes : [value, ...doc.poiTypes];
  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) {
          const raw = window.prompt("New POI type:");
          const t = raw?.trim().replace(/\s+/g, "_").toLowerCase();
          if (t) onCommit(t);
          return; // controlled value snaps back if the prompt was cancelled
        }
        onCommit(v);
      }}
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      <option value={NEW}>＋ new type…</option>
    </select>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <CommitInput
        value={String(Math.round(value * 100) / 100)}
        onCommit={(v) => {
          const n = parseFloat(v);
          if (isFinite(n)) onCommit(n);
        }}
      />
    </label>
  );
}

export function Inspector() {
  const doc = useDoc();
  const editor = useEditor();
  const floor = M.findFloor(doc, editor.floorId);
  const sel = editor.selection;

  return (
    <div className="panel">
      <div className="panel-title">Inspector</div>
      {!floor || !sel ? (
        <div className="muted small">
          Nothing selected.
          <br />
          <br />
          <b>W</b> draw walls (<b>D</b> = door segments) · <b>P</b> draw paths · <b>E</b> place
          POIs · <b>R</b> make rooms · <b>V</b> select/move.
          <br />
          <br />
          Right-click or Ctrl+Z steps a chain back; Esc finishes it. Hold Shift for 45° lock, Alt
          to disable snapping. Space/middle-mouse pans, wheel zooms, 0 fits.
        </div>
      ) : (
        <SelectionBody floor={floor} sel={sel} />
      )}
    </div>
  );
}

function SelectionBody({ floor, sel }: { floor: M.Floor; sel: ItemRef }) {
  switch (sel.kind) {
    case "node":
      return <NodeInspector floor={floor} layer={sel.layer} id={sel.id} />;
    case "edge":
      return <EdgeInspector floor={floor} layer={sel.layer} edgeKeyStr={sel.key} />;
    case "poi":
      return <PoiInspector floor={floor} id={sel.id} />;
    case "room":
      return <RoomInspector floor={floor} id={sel.id} />;
  }
}

function NodeInspector({
  floor,
  layer,
  id,
}: {
  floor: M.Floor;
  layer: "walls" | "nav";
  id: string;
}) {
  const doc = useDoc();
  const editor = useEditor();
  const g = layer === "walls" ? floor.walls : floor.nav;
  const node = g.nodes[id];
  const [linkKind, setLinkKind] = useState<M.LinkKind>("stairs");
  const [oneWay, setOneWay] = useState(false);
  if (!node) return null;

  const setCoord = (axis: "x" | "y") => (v: number) => {
    docStore.transact((p) => {
      const fl = M.findFloor(p, floor.id);
      const n = fl && (layer === "walls" ? fl.walls : fl.nav).nodes[id];
      if (n) n[axis] = v;
    });
  };

  const links = layer === "nav" ? M.linksTouchingNode(doc, floor.id, id) : [];
  const floorName = (fid: string) => M.findFloor(doc, fid)?.name ?? "missing floor";

  return (
    <div className="panel-section">
      <div className="muted small">
        {layer === "walls" ? "Wall" : "Nav"} node <code>{id}</code>
      </div>
      <NumberField label="x" value={node.x} onCommit={setCoord("x")} />
      <NumberField label="y" value={node.y} onCommit={setCoord("y")} />

      {layer === "nav" && (
        <>
          <div className="panel-title small">Inter-floor links</div>
          {links.length === 0 && <div className="muted small">None.</div>}
          {links.map((l, i) => {
            const outgoing = l.from.floor === floor.id && l.from.node === id;
            const other = outgoing ? l.to : l.from;
            return (
              <div className="row-between small" key={i}>
                <span>
                  {l.kind} {l.oneWay ? (outgoing ? "→" : "←") : "↔"} {floorName(other.floor)}{" "}
                  <code>{other.node}</code>
                </span>
                <button
                  className="mini danger"
                  onClick={() =>
                    docStore.transact((p) => {
                      const live = findLive(p, l);
                      p.interFloorEdges = p.interFloorEdges.filter((e) => e !== live);
                    })
                  }
                >
                  ✕
                </button>
              </div>
            );
          })}
          {editor.linking ? (
            <div className="muted small">
              Linking armed — switch floor and click the target nav node (Esc cancels).
            </div>
          ) : (
            <div className="link-form">
              <select
                value={linkKind}
                onChange={(e) => {
                  const kind = e.target.value as M.LinkKind;
                  setLinkKind(kind);
                  setOneWay(kind === "escalator");
                }}
              >
                <option value="stairs">stairs</option>
                <option value="elevator">elevator</option>
                <option value="escalator">escalator</option>
              </select>
              <label className="small">
                <input
                  type="checkbox"
                  checked={oneWay}
                  onChange={(e) => setOneWay(e.target.checked)}
                />
                one-way
              </label>
              <button
                className="mini"
                onClick={() =>
                  editorStore.update((s) => {
                    s.linking = { from: { floor: floor.id, node: id }, kind: linkKind, oneWay };
                  })
                }
              >
                Link to another floor…
              </button>
            </div>
          )}
        </>
      )}
      <DeleteButton label={`Delete node`} />
    </div>
  );
}

/** interFloorEdges array identity changes across transactions; re-find the same logical link. */
function findLive(p: M.Project, l: M.InterFloorEdge): M.InterFloorEdge | undefined {
  return p.interFloorEdges.find(
    (e) =>
      e.kind === l.kind &&
      e.oneWay === l.oneWay &&
      e.from.floor === l.from.floor &&
      e.from.node === l.from.node &&
      e.to.floor === l.to.floor &&
      e.to.node === l.to.node,
  );
}

function EdgeInspector({
  floor,
  layer,
  edgeKeyStr,
}: {
  floor: M.Floor;
  layer: "walls" | "nav";
  edgeKeyStr: string;
}) {
  const g = layer === "walls" ? floor.walls : floor.nav;
  const edge = g.edges[edgeKeyStr];
  if (!edge) return null;
  const A = g.nodes[edge.a];
  const B = g.nodes[edge.b];
  const lengthPx = A && B ? dist(A, B) : 0;
  const meters = floor.pxPerMeter ? lengthPx / floor.pxPerMeter : null;

  const kindsInUse = new Set<string>();
  for (const e of Object.values(g.edges)) if (e.kind) kindsInUse.add(e.kind);
  const seeds = layer === "walls" ? ["door", "window"] : ["accessible", "one_way"];
  for (const s of seeds) kindsInUse.add(s);

  return (
    <div className="panel-section">
      <div className="muted small">
        {layer === "walls" ? "Wall" : "Nav"} edge <code>{edge.a}</code>—<code>{edge.b}</code>
      </div>
      <div className="small">
        Length: {lengthPx.toFixed(1)} px{meters != null ? ` = ${meters.toFixed(2)} m` : ""}
      </div>
      <label className="field">
        <span>kind</span>
        <CommitInput
          value={edge.kind ?? ""}
          placeholder={layer === "walls" ? `(wall) — e.g. door` : `(default)`}
          list="edge-kinds"
          onCommit={(v) =>
            docStore.transact((p) => {
              const fl = M.findFloor(p, floor.id);
              const e = fl && (layer === "walls" ? fl.walls : fl.nav).edges[edgeKeyStr];
              if (e) {
                const t = v.trim();
                if (t) e.kind = t;
                else delete e.kind;
              }
            })
          }
        />
      </label>
      <datalist id="edge-kinds">
        {[...kindsInUse].map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <DeleteButton label="Delete edge" />
    </div>
  );
}

function PoiInspector({ floor, id }: { floor: M.Floor; id: string }) {
  const editor = useEditor();
  const poi = floor.pois[id];
  if (!poi) return null;
  const room = poi.roomId ? floor.rooms[poi.roomId] : undefined;

  return (
    <div className="panel-section">
      <div className="muted small">
        POI <code>{id}</code>
      </div>
      <label className="field">
        <span>type</span>
        <PoiTypeSelect
          value={poi.type}
          onCommit={(t) => {
            docStore.transact((p) => {
              const fl = M.findFloor(p, floor.id);
              const target = fl?.pois[id];
              if (target) target.type = t;
              if (!p.poiTypes.includes(t)) p.poiTypes.push(t);
            });
            editorStore.update((s) => {
              s.lastPoiType = t;
            });
          }}
        />
      </label>
      <label className="field">
        <span>name</span>
        <CommitInput
          value={poi.name ?? ""}
          placeholder="e.g. Fountain by gym"
          autoFocusNonce={editor.focusNonce}
          onCommit={(v) =>
            docStore.transact((p) => {
              const fl = M.findFloor(p, floor.id);
              const target = fl?.pois[id];
              if (!target) return;
              const t = v.trim();
              if (t) target.name = t;
              else delete target.name;
              if (target.roomId && fl!.rooms[target.roomId] && t) {
                fl!.rooms[target.roomId].name = t;
              }
            })
          }
        />
      </label>
      {room && (
        <div className="small">
          Room POI for <b>{room.name}</b>
        </div>
      )}
      {poi.navNodeId && (
        <div className="row-between small">
          <span>
            Nav node <code>{poi.navNodeId}</code>
          </span>
          <button
            className="mini"
            onClick={() =>
              docStore.transact((p) => {
                const fl = M.findFloor(p, floor.id);
                const target = fl?.pois[id];
                if (target) delete target.navNodeId;
              })
            }
            title="Detach the nav node from this POI (the node itself stays)"
          >
            Unlink
          </button>
        </div>
      )}
      {!poi.navNodeId && (
        <div className="muted small">
          Not routable yet — with the Path tool (P), click this POI to drop a linked nav node on
          it.
        </div>
      )}
      <DeleteButton label={room ? "Delete POI + room" : "Delete POI"} />
    </div>
  );
}

function RoomInspector({ floor, id }: { floor: M.Floor; id: string }) {
  const editor = useEditor();
  const room = floor.rooms[id];
  if (!room) return null;
  const roomPoi = floor.pois[room.poiId];
  const pts = room.loop.map((nid) => floor.walls.nodes[nid]).filter(Boolean);
  const areaPx = pts.length >= 3 ? Math.abs(polygonSignedArea(pts)) : 0;
  const areaM = floor.pxPerMeter ? areaPx / (floor.pxPerMeter * floor.pxPerMeter) : null;

  return (
    <div className="panel-section">
      <div className="muted small">
        Room <code>{id}</code> — {room.loop.length} corners
      </div>
      <label className="field">
        <span>name</span>
        <CommitInput
          value={room.name}
          autoFocusNonce={editor.focusNonce}
          onCommit={(v) => {
            const t = v.trim();
            if (!t) return;
            docStore.transact((p) => {
              const fl = M.findFloor(p, floor.id);
              const r = fl?.rooms[id];
              if (!r) return;
              r.name = t;
              const poi = fl!.pois[r.poiId];
              if (poi) poi.name = t;
            });
          }}
        />
      </label>
      {roomPoi && (
        <label className="field">
          <span>type</span>
          <PoiTypeSelect
            value={roomPoi.type}
            onCommit={(t) =>
              docStore.transact((p) => {
                const fl = M.findFloor(p, floor.id);
                const poi = fl?.pois[room.poiId];
                if (poi) poi.type = t;
                if (!p.poiTypes.includes(t)) p.poiTypes.push(t);
              })
            }
          />
        </label>
      )}
      <div className="small">
        Area: {Math.round(areaPx).toLocaleString()} px²
        {areaM != null ? ` = ${areaM.toFixed(1)} m²` : ""}
      </div>
      <DeleteButton label="Delete room" />
    </div>
  );
}

function DeleteButton({ label }: { label: string }) {
  return (
    <button className="wide danger" onClick={deleteSelection} title="Delete (Del)">
      {label}
    </button>
  );
}
