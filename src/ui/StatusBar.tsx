import * as M from "../core/model";
import { useDoc, useEditor, useOverlay } from "./hooks";

const SNAP_LABEL: Record<string, string> = {
  node: "snap: node",
  poi: "snap: POI",
  segment: "snap: on line",
  angle: "snap: angle",
  "angle-node": "snap: angle+align",
  "angle-segment": "snap: angle+line",
};

export function StatusBar() {
  const doc = useDoc();
  const editor = useEditor();
  const overlay = useOverlay();
  const floor = M.findFloor(doc, editor.floorId);
  const snapKind = overlay.snapPreview?.kind;

  return (
    <div className="statusbar">
      <span>
        {floor?.name ?? "—"} · layer: {editor.layer}
        {editor.doorMode ? " · DOOR MODE" : ""}
      </span>
      <span>
        {overlay.cursor
          ? `${overlay.cursor.x.toFixed(0)}, ${overlay.cursor.y.toFixed(0)} px`
          : ""}
      </span>
      <span>{snapKind && snapKind !== "none" ? SNAP_LABEL[snapKind] ?? "" : ""}</span>
      <span className="spacer" />
      <span>
        {floor?.pxPerMeter ? `${floor.pxPerMeter.toFixed(1)} px/m` : "uncalibrated"} ·{" "}
        {(overlay.viewport.zoom * 100).toFixed(0)}%
      </span>
    </div>
  );
}
