// Merge dialog: preview what "Add floors from another file…" would do, per
// floor, before committing. Floors whose id already exists in this project are
// REPLACED (same lineage — someone's fork of the shared building file); others
// are appended. Empty replacements default to unchecked so a contributor's
// untouched floors never wipe out finished ones.
import { useMemo, useState } from "react";
import { docStore, editorStore } from "../core/store";
import { setFloor } from "../core/tools";
import type { Project } from "../core/model";
import {
  mergePreview,
  mergeProjectInto,
  type FloorStats,
  type MergeResult,
} from "../core/interchange";
import { useDoc, useEscape } from "./hooks";

export interface MergeSource {
  fileName: string;
  project: Project;
  /** Import warnings from parsing the file (map-JSON recovery). */
  warnings: string[];
}

const stats = (s: FloorStats): string =>
  `${s.walls} walls · ${s.nav} nav · ${s.pois} POIs · ${s.rooms} rooms${s.image ? " · image" : ""}`;

export function MergeDialog({ source, onClose }: { source: MergeSource; onClose: () => void }) {
  const doc = useDoc();
  useEscape(onClose);
  const rows = useMemo(() => mergePreview(doc, source.project), [doc, source]);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.defaultChecked).map((r) => r.id)),
  );
  const srcId = source.project.buildingId;
  const mismatch = !!doc.buildingId && !!srcId && doc.buildingId !== srcId;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const merge = () => {
    const floorIds = new Set(checked);
    let result: MergeResult | null = null;
    try {
      docStore.transact((p) => {
        result = mergeProjectInto(p, source.project, { floorIds });
      });
    } catch (err) {
      editorStore.toast(`Couldn't merge: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const r = result as MergeResult | null;
    if (r) {
      const first = rows.find((row) => floorIds.has(row.id));
      if (first) setFloor(first.id);
      const parts: string[] = [];
      if (r.added.length) parts.push(`added ${r.added.length}`);
      if (r.replaced.length) parts.push(`replaced ${r.replaced.length}`);
      if (r.droppedLinks) parts.push(`dropped ${r.droppedLinks} stale link${r.droppedLinks === 1 ? "" : "s"}`);
      editorStore.toast(`Merged ${source.fileName}: ${parts.join(", ") || "nothing"}`);
    }
    for (const w of source.warnings.slice(0, 4)) editorStore.toast(w);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Add floors from {source.fileName}</div>
        <div className="small">
          {source.project.building}
          {srcId ? ` (${srcId})` : ""} · {rows.length} floor{rows.length === 1 ? "" : "s"} in the
          file
        </div>
        {mismatch && (
          <div className="warning-list">
            <div className="warning">
              ⚠ That file is for building "{srcId}" but this project is "{doc.buildingId}". Each
              building belongs in its own project — connect buildings through POIs (Inspector →
              Other building) instead of merging them.
            </div>
          </div>
        )}
        <div className="merge-list">
          {rows.map((r) => (
            <label key={r.id} className={`merge-row ${r.status}`}>
              <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
              <span className="merge-name">{r.name}</span>
              <span className="merge-status">
                {r.status === "new" ? "new floor" : `replaces "${r.targetName}"`}
              </span>
              <span className="merge-stats muted small">
                {stats(r.src)}
                {r.dst ? ` — currently ${stats(r.dst)}` : ""}
              </span>
            </label>
          ))}
        </div>
        <div className="muted small">
          Replacing keeps inter-floor links whose nav nodes still exist. Unchecked floors are left
          untouched. The merge is one undo step.
        </div>
        <div className="dialog-buttons">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={checked.size === 0} onClick={merge}>
            Merge {checked.size} floor{checked.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
