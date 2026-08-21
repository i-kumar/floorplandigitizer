// Global keyboard handling. The active tool gets first refusal (chain tools
// consume Esc/Enter/D and undo/redo); everything else lands in the global map.
import { docStore, editorStore } from "./store";
import {
  activeTool,
  deleteSelection,
  fitView,
  performRedo,
  performUndo,
  setFloor,
  setTool,
  zoomBy,
} from "./tools";

/** App-level actions the shortcut layer can trigger; registered by App.tsx. */
export const uiCallbacks = {
  save: () => {},
  open: () => {},
  export: () => {},
};

function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export function handleKeyDown(e: KeyboardEvent): void {
  if (inTextField(e)) {
    if (e.key === "Escape") (e.target as HTMLElement).blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) performRedo();
    else performUndo();
    return;
  }
  if (mod && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    performRedo();
    return;
  }
  if (mod && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    uiCallbacks.save();
    return;
  }
  if (mod && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    uiCallbacks.open();
    return;
  }
  if (mod && (e.key === "e" || e.key === "E")) {
    e.preventDefault();
    uiCallbacks.export();
    return;
  }
  if (mod) return;

  if (e.key === " ") {
    if (!editorStore.spaceDown) {
      editorStore.update((s) => {
        s.spaceDown = true;
      });
    }
    e.preventDefault();
    return;
  }

  if (activeTool().onKey?.(e)) {
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case "v":
    case "V":
      setTool("select");
      break;
    case "w":
    case "W":
      setTool("wall");
      break;
    case "p":
    case "P":
      setTool("path");
      break;
    case "e":
    case "E":
      setTool("poi");
      break;
    case "r":
    case "R":
      setTool("room");
      break;
    case "c":
    case "C":
      setTool("calibrate");
      break;
    case "Escape":
      editorStore.update((s) => {
        s.linking = null;
        s.selection = null;
      });
      break;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      deleteSelection();
      break;
    case "+":
    case "=":
      zoomBy(1.25);
      break;
    case "-":
    case "_":
      zoomBy(0.8);
      break;
    case "0":
      fitView();
      break;
    default: {
      if (/^[1-9]$/.test(e.key)) {
        const floor = docStore.project.floors[Number(e.key) - 1];
        if (floor) setFloor(floor.id);
      }
    }
  }
}

export function handleKeyUp(e: KeyboardEvent): void {
  if (e.key === " " && editorStore.spaceDown) {
    editorStore.update((s) => {
      s.spaceDown = false;
    });
  }
}

export function handleWindowBlur(): void {
  activeTool().deactivate();
  if (editorStore.spaceDown) {
    editorStore.update((s) => {
      s.spaceDown = false;
    });
  }
}
