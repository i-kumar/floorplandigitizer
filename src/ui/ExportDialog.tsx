// Export dialog: runs validation, lists warnings, downloads the map JSON.
import { useMemo, useState } from "react";
import { buildExport } from "../core/export";
import { downloadJson } from "../core/persist";
import { editorStore } from "../core/store";
import { useDoc, useEscape } from "./hooks";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  useEscape(onClose);
  const result = useMemo(() => buildExport(doc), [doc]);
  const [copied, setCopied] = useState(false);

  const warns = result.warnings.filter((w) => w.level === "warn");
  const infos = result.warnings.filter((w) => w.level === "info");
  const stats = result.json.floors.reduce(
    (acc, f) => ({
      walls: acc.walls + f.walls.length,
      nodes: acc.nodes + f.nav.nodes.length,
      edges: acc.edges + f.nav.edges.length,
      pois: acc.pois + f.pois.length,
      rooms: acc.rooms + f.rooms.length,
    }),
    { walls: 0, nodes: 0, edges: 0, pois: 0, rooms: 0 },
  );

  const filename =
    (doc.building || "building").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") ||
    "building";

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Export map data</div>
        <div className="small">
          {result.json.floors.length} floor{result.json.floors.length === 1 ? "" : "s"} ·{" "}
          {stats.walls} wall segments · {stats.nodes} nav nodes / {stats.edges} edges ·{" "}
          {stats.pois} POIs · {stats.rooms} rooms · {result.json.interFloorEdges.length}{" "}
          inter-floor links
        </div>

        {warns.length > 0 && (
          <div className="warning-list">
            {warns.map((w, i) => (
              <div key={i} className="warning">
                ⚠ {w.message}
              </div>
            ))}
          </div>
        )}
        {infos.length > 0 && (
          <div className="warning-list">
            {infos.map((w, i) => (
              <div key={i} className="info">
                ℹ {w.message}
              </div>
            ))}
          </div>
        )}
        {result.warnings.length === 0 && <div className="ok">✓ No validation warnings</div>}

        <div className="dialog-buttons">
          <button onClick={onClose}>Close</button>
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(JSON.stringify(result.json, null, 2))
                .then(() => setCopied(true))
                .catch(() => editorStore.toast("Clipboard unavailable"));
            }}
          >
            {copied ? "Copied ✓" : "Copy JSON"}
          </button>
          <button
            className="primary"
            onClick={() => {
              downloadJson(`${filename}.map.json`, result.json);
              onClose();
            }}
          >
            Download {filename}.map.json
          </button>
        </div>
      </div>
    </div>
  );
}
