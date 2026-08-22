import { useEffect, useState } from "react";
import { docStore, editorStore, type LayerId, type ToolId } from "../core/store";
import { performRedo, performUndo, setLayer, setTool } from "../core/tools";
import { useDocStore, useEditor } from "./hooks";

const TOOLS: Array<{ id: ToolId; label: string; keyHint: string; title: string }> = [
  { id: "select", label: "Select", keyHint: "V", title: "Select / move / delete (V)" },
  { id: "pan", label: "Pan", keyHint: "H", title: "Pan by dragging (H) — scroll also pans; pinch or ⌘+scroll zooms" },
  { id: "wall", label: "Walls", keyHint: "W", title: "Draw wall chains (W) — D toggles door segments" },
  { id: "path", label: "Paths", keyHint: "P", title: "Draw the walkable nav network (P)" },
  { id: "poi", label: "POI", keyHint: "E", title: "Place points of interest (E)" },
  { id: "room", label: "Room", keyHint: "R", title: "Create a room from an enclosed wall region (R)" },
  { id: "outline", label: "Outline", keyHint: "O", title: "Draw the building footprint: click wall corners in order, click the first again to close (O)" },
  { id: "calibrate", label: "Scale", keyHint: "C", title: "Calibrate px-per-meter (C)" },
];

const LAYERS: Array<{ id: LayerId; label: string }> = [
  { id: "walls", label: "Walls" },
  { id: "nav", label: "Nav" },
  { id: "pois", label: "POIs" },
];

interface Props {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onPoiTypes: () => void;
}

export function Toolbar({ onNew, onOpen, onSave, onExport, onPoiTypes }: Props) {
  const editor = useEditor();
  const doc = useDocStore();
  const [name, setName] = useState(doc.project.building);

  useEffect(() => {
    setName(doc.project.building);
  }, [doc.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitName = () => {
    const trimmed = name.trim() || "Building";
    if (trimmed !== doc.project.building) {
      docStore.transact((p) => {
        p.building = trimmed;
      });
    }
    setName(trimmed);
  };

  return (
    <div className="toolbar">
      <input
        className="building-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        title="Building name"
      />

      <div className="tool-group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={editor.tool === t.id ? "tool active" : "tool"}
            title={t.title}
            onClick={() => setTool(t.id)}
          >
            {t.label}
            <span className="key-hint">{t.keyHint}</span>
          </button>
        ))}
      </div>

      {editor.tool === "wall" && (
        <button
          className={editor.doorMode ? "tool door active" : "tool door"}
          title="Next wall segments become door openings (D)"
          onClick={() =>
            editorStore.update((s) => {
              s.doorMode = !s.doorMode;
            })
          }
        >
          Door
          <span className="key-hint">D</span>
        </button>
      )}

      <div className="tool-group">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            className={editor.layer === l.id ? "chip active" : "chip"}
            title={`Active layer: ${l.label}`}
            onClick={() => setLayer(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>

      <label className="opacity">
        Plan
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={editor.imageOpacity}
          onChange={(e) =>
            editorStore.update((s) => {
              s.imageOpacity = Number(e.target.value);
            })
          }
          title="Floor plan image opacity"
        />
      </label>

      <div className="tool-group">
        <button
          className="tool"
          disabled={!doc.canUndo && !editor.chainAnchor}
          onClick={performUndo}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button className="tool" disabled={!doc.canRedo} onClick={performRedo} title="Redo (Ctrl+Shift+Z)">
          ↪
        </button>
      </div>

      <div className="spacer" />

      <div className="tool-group">
        <button className="tool" onClick={onPoiTypes} title="Edit the POI type list">
          POI Types
        </button>
        <button className="tool" onClick={onNew} title="Start a new empty project">
          New
        </button>
        <button className="tool" onClick={onOpen} title="Open a .floorplan.json project (Ctrl+O)">
          Open
        </button>
        <button className="tool" onClick={onSave} title="Save the project file (Ctrl+S)">
          Save
        </button>
        <button className="tool primary" onClick={onExport} title="Export map data JSON (Ctrl+E)">
          Export
        </button>
      </div>
    </div>
  );
}
