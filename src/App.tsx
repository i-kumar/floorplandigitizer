import { useEffect, useRef, useState } from "react";
import { CanvasView } from "./ui/CanvasView";
import { Toolbar } from "./ui/Toolbar";
import { FloorPanel, applyFloorImage } from "./ui/FloorPanel";
import { Inspector } from "./ui/Inspector";
import { StatusBar } from "./ui/StatusBar";
import { ExportDialog } from "./ui/ExportDialog";
import { PdfImportDialog } from "./ui/PdfImportDialog";
import { docStore, editorStore } from "./core/store";
import { newProject } from "./core/model";
import {
  clearAutosave,
  loadProjectFile,
  saveProjectFile,
} from "./core/persist";
import {
  handleKeyDown,
  handleKeyUp,
  handleWindowBlur,
  uiCallbacks,
} from "./core/shortcuts";
import { loadImageFile } from "./core/pdf";
import { useEditor } from "./ui/hooks";

export default function App() {
  const editor = useEditor();
  const [showExport, setShowExport] = useState(false);
  const [droppedPdf, setDroppedPdf] = useState<File | null>(null);
  const openRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    uiCallbacks.save = saveProjectFile;
    uiCallbacks.open = () => openRef.current?.click();
    uiCallbacks.export = () => setShowExport(true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  const onNew = () => {
    if (!window.confirm("Start a new empty project? The current one is discarded (save it first if needed)."))
      return;
    docStore.replace(newProject());
    void clearAutosave();
  };

  const onOpenFile = async (file: File) => {
    try {
      await loadProjectFile(file);
      editorStore.toast(`Loaded ${file.name}`);
    } catch (err) {
      editorStore.toast(
        `Could not load project: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const onDropFiles = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (/\.floorplan\.json$/i.test(file.name) || file.type === "application/json") {
      void onOpenFile(file);
    } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      setDroppedPdf(file);
    } else if (/^image\//.test(file.type)) {
      void loadImageFile(file)
        .then((img) => {
          if (applyFloorImage(editorStore.floorId, img)) editorStore.toast("Image imported");
        })
        .catch(() => editorStore.toast("Could not decode that image"));
    } else {
      editorStore.toast("Drop a PDF, image, or .floorplan.json file");
    }
  };

  return (
    <div className="app">
      <Toolbar
        onNew={onNew}
        onOpen={() => openRef.current?.click()}
        onSave={saveProjectFile}
        onExport={() => setShowExport(true)}
      />
      <div className="main">
        <div className="canvas-wrap">
          <CanvasView onDropFiles={onDropFiles} />
          {editor.linking && (
            <div className="banner">
              Linking a {editor.linking.kind}: switch floors (1–9 or the panel) and click the
              target nav node — Esc cancels
            </div>
          )}
          {editor.tool === "calibrate" && (
            <div className="banner calm">
              Calibrate: click two points a known distance apart
              {editor.calibPoint ? " — now click the second point" : ""}
            </div>
          )}
          {editor.tool === "outline" && (
            <div className="banner calm">
              Outline: click the building's corner nodes in order — click the first one again
              (or press Enter) to finish; right-click/Ctrl+Z un-picks; Esc cancels
            </div>
          )}
          {editor.tool === "door" && (
            <div className="banner calm">
              Door: click where the door starts on a wall, then where it ends — one click on an
              existing door segment attaches its POI; Esc cancels
            </div>
          )}
        </div>
        <aside className="sidebar">
          <FloorPanel />
          <Inspector />
        </aside>
      </div>
      <StatusBar />

      <div className="toasts">
        {editor.toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {droppedPdf && <PdfImportDialog file={droppedPdf} onClose={() => setDroppedPdf(null)} />}

      <input
        ref={openRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onOpenFile(file);
        }}
      />
    </div>
  );
}
