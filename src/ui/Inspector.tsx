// Contextual properties for the current selection: node coords + inter-floor
// links, edge kinds, POI type/name/links, room name/area.
import { useEffect, useRef, useState } from "react";
import { docStore, editorStore, type ItemRef } from "../core/store";
import { deleteSelection } from "../core/tools";
import * as M from "../core/model";
import { dist, polygonSignedArea } from "../core/geometry";
import {
  EXTERNAL_LINK_KINDS,
  POI_ACCESS,
  typeOptionsFor,
  vocabLabel,
  type VocabEntry,
} from "../core/vocab";
import { useDoc, useEditor } from "./hooks";

/** Each focusNonce bump is consumed by exactly one input: the name field of the
 *  POI/room that was just created. Without this, any later (re)mount of an
 *  inspector with the same nonce would refocus its field and swallow keyboard
 *  shortcuts like Delete. Consumed when the focus actually happens (inside the
 *  timeout), not when the effect runs — StrictMode runs effects twice in dev and
 *  cancels the first timeout, which would otherwise swallow the focus. */
let consumedFocusNonce = 0;

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
    if (!autoFocusNonce || autoFocusNonce === consumedFocusNonce) return;
    // Defer past the canvas click's default action, which would otherwise
    // steal focus straight back to the canvas. Select everything so typing a
    // name (e.g. a room number) replaces the placeholder "Room 7" immediately.
    const t = setTimeout(() => {
      if (autoFocusNonce === consumedFocusNonce) return;
      consumedFocusNonce = autoFocusNonce;
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

/** Real dropdown over the closed vocabulary (a datalist filters by the current
 *  text, hiding the other options). A legacy value that isn't offered stays
 *  selectable so old files open cleanly — export flags it. */
function PoiTypeSelect({
  value,
  vocab,
  onCommit,
  disabled,
}: {
  value: string;
  vocab: VocabEntry[];
  onCommit: (t: string) => void;
  disabled?: boolean;
}) {
  const known = vocab.some((e) => e.id === value);
  return (
    <select value={value} disabled={disabled} onChange={(e) => onCommit(e.target.value)}>
      {!known && <option value={value}>{vocabLabel(value)}</option>}
      {vocab.map((e) => (
        <option key={e.id} value={e.id}>
          {e.label}
        </option>
      ))}
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
          POIs · <b>R</b> make rooms · <b>O</b> draw the outline · <b>V</b> select/move ·{" "}
          <b>H</b> pan.
          <br />
          <br />
          Right-click or Ctrl+Z steps a chain back; Esc finishes it. Hold Shift for 45° lock, Alt
          to disable snapping. Scroll (or Space/H-drag) pans, pinch or ⌘+scroll zooms, 0 fits.
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
      if (!fl || !n) return;
      const pt = { x: n.x, y: n.y, [axis]: v };
      if (layer === "walls") M.moveWallNode(fl, id, pt); // door spans follow
      else {
        n.x = pt.x;
        n.y = pt.y;
      }
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
  const doorPoi = layer === "walls" ? M.doorPoiForEdge(floor, edgeKeyStr) : undefined;

  const selectPoi = (pid: string, focus = false) =>
    editorStore.update((s) => {
      s.layer = "pois";
      s.selection = { kind: "poi", id: pid };
      if (focus) s.focusNonce++;
    });

  return (
    <div className="panel-section">
      <div className="muted small">
        {layer === "walls" ? "Wall" : "Nav"} edge <code>{edge.a}</code>—<code>{edge.b}</code>
      </div>
      <div className="small">
        Length: {lengthPx.toFixed(1)} px{meters != null ? ` = ${meters.toFixed(2)} m` : ""}
      </div>
      {layer === "walls" && edge.kind === "door" && doorPoi && (
        <div className="row-between small">
          <span>
            Door POI <b>{doorPoi.name || doorPoi.id}</b>
          </span>
          <button className="mini" onClick={() => selectPoi(doorPoi.id)}>
            Select
          </button>
        </div>
      )}
      {layer === "walls" && edge.kind === "door" && !doorPoi && (
        <button
          className="wide"
          title="Every door needs exactly one POI spanning it — this creates it for this edge"
          onClick={() => {
            let pid = "";
            docStore.transact((p) => {
              const fl = M.findFloor(p, floor.id);
              const poi = fl && M.createDoorPoi(p, fl, [edge.a, edge.b]);
              if (poi) pid = poi.id;
            });
            if (pid) selectPoi(pid, true);
          }}
        >
          Add door POI
        </button>
      )}
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
  const ext = poi.externalLink;

  const update = (fn: (target: M.Poi, fl: M.Floor) => void) =>
    docStore.transact((p) => {
      const fl = M.findFloor(p, floor.id);
      const target = fl?.pois[id];
      if (fl && target) fn(target, fl);
    });

  return (
    <div className="panel-section">
      <div className="muted small">
        POI <code>{id}</code>
        {poi.span ? ` · door spanning ${poi.span.length} wall nodes` : ""}
      </div>
      <label className="field">
        <span>type</span>
        <PoiTypeSelect
          value={poi.type}
          vocab={typeOptionsFor(poi)}
          disabled={!!poi.span}
          onCommit={(t) => {
            update((target) => {
              target.type = t;
            });
            if (!poi.roomId) {
              editorStore.update((s) => {
                s.lastPoiType = t;
              });
            }
          }}
        />
      </label>
      <label className="field">
        <span>name</span>
        <CommitInput
          value={poi.name ?? ""}
          placeholder={poi.type === "door" ? "e.g. Main entrance" : "e.g. Fountain by gym"}
          autoFocusNonce={editor.focusNonce}
          onCommit={(v) =>
            update((target, fl) => {
              const t = v.trim();
              if (t) target.name = t;
              else delete target.name;
              if (target.roomId && fl.rooms[target.roomId] && t) {
                fl.rooms[target.roomId].name = t;
              }
            })
          }
        />
      </label>
      {poi.type === "door" && (
        <label className="field">
          <span>access</span>
          <select
            value={poi.access ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              update((target) => {
                if (v === "emergency_only") target.access = "emergency_only";
                else delete target.access;
              });
            }}
          >
            <option value="">Normal</option>
            {POI_ACCESS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {poi.span && (
        <div className="muted small">
          Its extent follows the wall nodes it spans — drag those on the Walls layer to resize.
        </div>
      )}
      {poi.type === "door" && !poi.span && (
        <div className="muted small">
          This door is a point — redraw it with the Door tool (D) to give it an extent.
        </div>
      )}
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
              update((target) => {
                delete target.navNodeId;
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

      <div className="panel-title small">Other building</div>
      {ext ? (
        <>
          <label className="field">
            <span>building id</span>
            <CommitInput
              value={ext.building}
              placeholder="their id, e.g. library"
              onCommit={(v) =>
                update((target) => {
                  if (target.externalLink) target.externalLink.building = M.buildingSlug(v);
                })
              }
            />
          </label>
          <label className="field">
            <span>key</span>
            <CommitInput
              value={ext.key}
              placeholder="shared, e.g. bridge-2f"
              onCommit={(v) =>
                update((target) => {
                  if (target.externalLink) target.externalLink.key = v.trim();
                })
              }
            />
          </label>
          <label className="field">
            <span>kind</span>
            <select
              value={ext.kind ?? "door"}
              onChange={(e) => {
                const v = e.target.value;
                update((target) => {
                  if (target.externalLink) target.externalLink.kind = v;
                });
              }}
            >
              {EXTERNAL_LINK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <div className="muted small">
            The other side marks its door with <b>your</b> building id and the same key; the
            linker joins the two nav nodes.
            {!poi.navNodeId ? " This POI still needs a nav node." : ""}
          </div>
          <button
            className="mini"
            onClick={() =>
              update((target) => {
                delete target.externalLink;
              })
            }
          >
            Remove link
          </button>
        </>
      ) : (
        <button
          className="mini"
          title="Mark this POI as the connection to another building (door, bridge, tunnel…)"
          onClick={() =>
            update((target) => {
              target.externalLink = { building: "", key: "", kind: "door" };
            })
          }
        >
          Connects to another building…
        </button>
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
            vocab={typeOptionsFor(roomPoi)}
            onCommit={(t) =>
              docStore.transact((p) => {
                const fl = M.findFloor(p, floor.id);
                const poi = fl?.pois[room.poiId];
                if (poi) poi.type = t;
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
