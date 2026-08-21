import { useEffect, useSyncExternalStore } from "react";
import {
  docStore,
  editorStore,
  overlayStore,
  type DocStore,
  type EditorStore,
  type OverlayStore,
} from "../core/store";
import type { Project } from "../core/model";

interface Subscribable {
  subscribe: (fn: () => void) => () => void;
  version: number;
}

function useVersion(store: Subscribable): number {
  return useSyncExternalStore(store.subscribe, () => store.version);
}

/** Re-renders on any document change; read fields directly off the returned project. */
export function useDoc(): Project {
  useVersion(docStore);
  return docStore.project;
}

export function useDocStore(): DocStore {
  useVersion(docStore);
  return docStore;
}

export function useEditor(): EditorStore {
  useVersion(editorStore);
  return editorStore;
}

/** High-frequency state (viewport, cursor, snap) — subscribe only where needed. */
export function useOverlay(): OverlayStore {
  useVersion(overlayStore);
  return overlayStore;
}

/** Close a dialog on Escape. Capture-phase so the editor's global Escape
 *  handling (clear selection etc.) doesn't also fire. Pass null to disable
 *  (e.g. while a dialog is busy). */
export function useEscape(onClose: (() => void) | null): void {
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);
}
