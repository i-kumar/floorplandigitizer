// Floor list: switch/add/rename/reorder/delete floors, import plan images
// (PDF page picker or PNG/JPG), and calibration readout.
import { useRef, useState } from "react";
import { docStore, editorStore } from "../core/store";
import { fitView, setFloor, setTool } from "../core/tools";
import * as M from "../core/model";
import { useDoc, useEditor } from "./hooks";
import { loadImageFile } from "../core/pdf";
import { PdfImportDialog } from "./PdfImportDialog";

export function applyFloorImage(floorId: string, image: M.FloorImage): boolean {
  const floor = M.findFloor(docStore.project, floorId);
  if (!floor) return false;
  const hasGeometry =
    Object.keys(floor.walls.nodes).length > 0 ||
    Object.keys(floor.nav.nodes).length > 0 ||
    Object.keys(floor.pois).length > 0;
  let rescale = false;
  if (
    floor.image &&
    hasGeometry &&
    (floor.image.width !== image.width || floor.image.height !== image.height)
  ) {
    const ow = floor.image.width;
    const oh = floor.image.height;
    rescale = window.confirm(
      `This floor was traced over a ${ow}×${oh}px image; the new one is ` +
        `${image.width}×${image.height}px.\n\n` +
        `OK — scale the traced geometry proportionally to fit the new image ` +
        `(right choice when re-importing the same plan at a higher resolution).\n` +
        `Cancel — more options.`,
    );
    if (!rescale) {
      const keep = window.confirm(
        `Replace the image WITHOUT rescaling? The traced geometry keeps its ` +
          `current pixel coordinates.\n\nCancel aborts the import entirely.`,
      );
      if (!keep) return false;
    }
  }
  const old = floor.image;
  docStore.transact((p) => {
    const fl = M.findFloor(p, floorId);
    if (!fl) return;
    if (rescale && old) {
      M.rescaleFloorGeometry(fl, image.width / old.width, image.height / old.height);
    }
    fl.image = image;
  });
  if (rescale && old && floor.pxPerMeter != null) {
    const uniform = Math.abs(image.width / old.width - image.height / old.height) < 1e-6;
    if (!uniform) editorStore.toast("Aspect ratio changed — calibration cleared, re-run it");
  }
  if (floorId === editorStore.floorId) fitView();
  return true;
}

export function FloorPanel() {
  const doc = useDoc();
  const editor = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  const current = M.findFloor(doc, editor.floorId);

  const handleFile = async (file: File) => {
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        setPdfFile(file);
      } else {
        const img = await loadImageFile(file);
        if (applyFloorImage(editor.floorId, img)) {
          editorStore.toast(`Image set for ${current?.name ?? "floor"}`);
        }
      }
    } catch (err) {
      editorStore.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const addFloor = () => {
    let id = "";
    docStore.transact((p) => {
      const floor = M.newFloor(p, `Floor ${p.floors.length + 1}`);
      p.floors.push(floor);
      id = floor.id;
    });
    setFloor(id);
  };

  const removeFloor = (fid: string) => {
    const floor = M.findFloor(doc, fid);
    if (!floor) return;
    const links = M.linksTouchingFloor(doc, fid).length;
    const suffix = links ? ` ${links} inter-floor link${links === 1 ? "" : "s"} will be removed.` : "";
    if (!window.confirm(`Delete "${floor.name}" and everything drawn on it?${suffix}`)) return;
    docStore.transact((p) => {
      M.deleteFloor(p, fid);
    });
  };

  const moveFloor = (fid: string, delta: number) => {
    docStore.transact((p) => {
      const i = p.floors.findIndex((f) => f.id === fid);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= p.floors.length) return;
      const [f] = p.floors.splice(i, 1);
      p.floors.splice(j, 0, f);
    });
  };

  const commitRename = () => {
    if (renaming) {
      const text = renameText.trim();
      if (text) {
        docStore.transact((p) => {
          const fl = M.findFloor(p, renaming);
          if (fl) fl.name = text;
        });
      }
    }
    setRenaming(null);
  };

  return (
    <div className="panel">
      <div className="panel-title">
        Floors
        <button className="mini" onClick={addFloor} title="Add a floor">
          + Add
        </button>
      </div>
      <div className="floor-list">
        {doc.floors.map((f, i) => (
          <div
            key={f.id}
            className={f.id === editor.floorId ? "floor-row active" : "floor-row"}
            onClick={() => setFloor(f.id)}
          >
            <span className="floor-index">{i + 1}</span>
            {renaming === f.id ? (
              <input
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="floor-name"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenaming(f.id);
                  setRenameText(f.name);
                }}
                title="Double-click to rename"
              >
                {f.name}
              </span>
            )}
            <span className="floor-buttons" onClick={(e) => e.stopPropagation()}>
              <button className="mini" onClick={() => moveFloor(f.id, -1)} disabled={i === 0} title="Move up">
                ↑
              </button>
              <button
                className="mini"
                onClick={() => moveFloor(f.id, 1)}
                disabled={i === doc.floors.length - 1}
                title="Move down"
              >
                ↓
              </button>
              <button className="mini danger" onClick={() => removeFloor(f.id)} title="Delete floor">
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="panel-section">
        <button className="wide" onClick={() => fileRef.current?.click()}>
          {current?.image ? "Replace plan (PDF / image)…" : "Import plan (PDF / image)…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
        {current?.image && (
          <div className="muted small">
            {current.image.width}×{current.image.height}px
            {current.image.source
              ? ` — ${current.image.source.fileName}${
                  current.image.source.page ? ` p.${current.image.source.page}` : ""
                }`
              : ""}
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="row-between">
          <span className="muted small">
            Outline:{" "}
            {current?.outline ? `${current.outline.length} corners` : "not set"}
          </span>
          <span>
            <button
              className="mini"
              title="Draw the footprint: click wall corners in order, click the first again (or Enter) to close (O)"
              onClick={() => setTool("outline")}
            >
              Draw
            </button>
            {current?.outline && (
              <button
                className="mini"
                title="Remove the outline"
                onClick={() =>
                  docStore.transact((p) => {
                    const fl = M.findFloor(p, editor.floorId);
                    if (fl) fl.outline = null;
                  })
                }
              >
                Clear
              </button>
            )}
          </span>
        </div>
        <div className="row-between">
          <span className="muted small">
            Scale:{" "}
            {current?.pxPerMeter ? `${current.pxPerMeter.toFixed(2)} px/m` : "not calibrated"}
          </span>
          <span>
            <button className="mini" onClick={() => setTool("calibrate")} title="Calibrate (C)">
              Calibrate
            </button>
            {current?.pxPerMeter != null && (
              <button
                className="mini"
                onClick={() =>
                  docStore.transact((p) => {
                    const fl = M.findFloor(p, editor.floorId);
                    if (fl) fl.pxPerMeter = null;
                  })
                }
                title="Clear calibration"
              >
                Clear
              </button>
            )}
          </span>
        </div>
      </div>

      {pdfFile && <PdfImportDialog file={pdfFile} onClose={() => setPdfFile(null)} />}
    </div>
  );
}
