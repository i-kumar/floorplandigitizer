// Edit the project's POI type list. The list is suggestions — deleting a type
// never mutates POIs that already use it.
import { useState } from "react";
import { docStore } from "../core/store";
import { poiColor } from "../core/colors";
import { useDoc, useEscape } from "./hooks";

export function PoiTypesDialog({ onClose }: { onClose: () => void }) {
  const doc = useDoc();
  const [text, setText] = useState("");
  useEscape(onClose);

  const add = () => {
    const t = text.trim().replace(/\s+/g, "_").toLowerCase();
    if (!t) return;
    if (!doc.poiTypes.includes(t)) {
      docStore.transact((p) => {
        p.poiTypes.push(t);
      });
    }
    setText("");
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog narrow" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">POI types</div>
        <div className="type-list">
          {doc.poiTypes.map((t) => (
            <div key={t} className="row-between small">
              <span>
                <span className="swatch" style={{ background: poiColor(t) }} />
                <code>{t}</code>
              </span>
              <button
                className="mini danger"
                title="Remove from suggestions (existing POIs keep their type)"
                onClick={() =>
                  docStore.transact((p) => {
                    p.poiTypes = p.poiTypes.filter((x) => x !== t);
                  })
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="link-form">
          <input
            value={text}
            placeholder="new_type"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button className="mini" onClick={add}>
            Add
          </button>
        </div>
        <div className="dialog-buttons">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
