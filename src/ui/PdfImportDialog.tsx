// PDF page picker: choose one page for the current floor, or create one floor
// per selected page. Rasterization happens BEFORE the (synchronous) transaction.
import { useEffect, useState } from "react";
import { docStore, editorStore } from "../core/store";
import { fitView, setFloor } from "../core/tools";
import * as M from "../core/model";
import { openPdf, renderPdfPage, renderPdfThumb, type PdfHandle } from "../core/pdf";
import { applyFloorImage } from "./FloorPanel";
import { useEditor, useEscape } from "./hooks";

interface Props {
  file: File;
  onClose: () => void;
}

export function PdfImportDialog({ file, onClose }: Props) {
  const editor = useEditor();
  const [pdf, setPdf] = useState<PdfHandle | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscape(busy ? null : onClose);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const pd = await openPdf(file);
        if (!alive) return;
        setPdf(pd);
        if (pd.pageCount === 1) setSelected(new Set([1]));
        for (let p = 1; p <= pd.pageCount; p++) {
          const thumb = await renderPdfThumb(pd, p);
          if (!alive) return;
          setThumbs((t) => ({ ...t, [p]: thumb }));
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const toggle = (page: number) => {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  const pages = [...selected].sort((a, b) => a - b);

  const useForCurrentFloor = async () => {
    if (!pdf || pages.length !== 1) return;
    setBusy(`Rendering page ${pages[0]}…`);
    try {
      const img = await renderPdfPage(pdf, pages[0]);
      if (applyFloorImage(editor.floorId, img)) {
        editorStore.toast("Floor plan imported");
        onClose();
      } else {
        setBusy(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const createFloors = async () => {
    if (!pdf || !pages.length) return;
    try {
      const images: M.FloorImage[] = [];
      for (let i = 0; i < pages.length; i++) {
        setBusy(`Rendering page ${pages[i]} (${i + 1}/${pages.length})…`);
        images.push(await renderPdfPage(pdf, pages[i]));
      }
      // A completely untouched current floor takes the first page instead of
      // leaving an empty floor behind.
      const current = M.findFloor(docStore.project, editor.floorId);
      const currentIsEmpty =
        !!current &&
        !current.image &&
        Object.keys(current.walls.nodes).length === 0 &&
        Object.keys(current.nav.nodes).length === 0 &&
        Object.keys(current.pois).length === 0;
      let firstId = "";
      docStore.transact((p) => {
        images.forEach((img, i) => {
          if (i === 0 && currentIsEmpty) {
            const fl = M.findFloor(p, editor.floorId)!;
            fl.image = img;
            firstId = fl.id;
            return;
          }
          const floor = M.newFloor(p, `Floor ${p.floors.length + 1}`);
          floor.image = img;
          p.floors.push(floor);
          if (!firstId) firstId = floor.id;
        });
      });
      if (firstId) setFloor(firstId);
      fitView();
      editorStore.toast(`Created ${images.length} floor${images.length === 1 ? "" : "s"}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Import PDF — {file.name}</div>
        {error && <div className="error">{error}</div>}
        {!pdf && !error && <div className="muted">Opening PDF…</div>}
        {pdf && (
          <>
            <div className="muted small">
              {pdf.pageCount} page{pdf.pageCount === 1 ? "" : "s"} — click to select
            </div>
            <div className="thumb-grid">
              {Array.from({ length: pdf.pageCount }, (_, i) => i + 1).map((page) => (
                <div
                  key={page}
                  className={selected.has(page) ? "thumb selected" : "thumb"}
                  onClick={() => toggle(page)}
                >
                  {thumbs[page] ? (
                    <img src={thumbs[page]} alt={`Page ${page}`} />
                  ) : (
                    <div className="thumb-loading">…</div>
                  )}
                  <div className="thumb-label">p.{page}</div>
                </div>
              ))}
            </div>
            {busy && <div className="muted">{busy}</div>}
            <div className="dialog-buttons">
              <button onClick={onClose} disabled={!!busy}>
                Cancel
              </button>
              <button
                onClick={() => void useForCurrentFloor()}
                disabled={pages.length !== 1 || !!busy}
                title="Use the selected page as the current floor's plan"
              >
                Set current floor
              </button>
              <button
                className="primary"
                onClick={() => void createFloors()}
                disabled={!pages.length || !!busy}
                title="Create one new floor per selected page"
              >
                Create {pages.length || ""} floor{pages.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
