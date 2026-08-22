// The <canvas> host: binds pointer/wheel events, normalizes them into image-space
// PointerInfo, and routes them through the input router. Owns the renderer lifecycle.
import { useEffect, useRef } from "react";
import { renderer } from "../core/renderer";
import { overlayStore, editorStore } from "../core/store";
import { router, type PointerInfo } from "../core/tools";
import { useEditor } from "./hooks";

interface Props {
  onDropFiles?: (files: File[]) => void;
}

export function CanvasView({ onDropFiles }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dropRef = useRef(onDropFiles);
  dropRef.current = onDropFiles;
  const editor = useEditor();

  useEffect(() => {
    const canvas = ref.current!;
    renderer.attach(canvas);

    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      overlayStore.update((s) => {
        s.viewW = r.width;
        s.viewH = r.height;
      });
    });
    ro.observe(canvas);

    const toInfo = (e: { clientX: number; clientY: number; button?: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): PointerInfo => {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const v = overlayStore.viewport;
      return {
        img: { x: (screen.x - v.x) / v.zoom, y: (screen.y - v.y) / v.zoom },
        screen,
        button: e.button ?? 0,
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl: e.ctrlKey,
      };
    };

    const down = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      canvas.setPointerCapture(e.pointerId);
      canvas.focus?.();
      router.onPointerDown(e, toInfo(e));
    };
    const move = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      router.onPointerMove(e, toInfo(e));
    };
    const up = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      router.onPointerUp(e, toInfo(e));
    };
    const cancel = () => router.onPointerCancel();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      router.onWheel(e, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const contextmenu = (e: Event) => e.preventDefault();
    const dblclick = (e: MouseEvent) => router.onDoubleClick(toInfo(e));
    const dragover = (e: DragEvent) => {
      e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) dropRef.current?.(files);
    };
    const leave = () => {
      overlayStore.update((s) => {
        s.cursor = null;
        if (!editorStore.chainAnchor) s.snapPreview = null;
      });
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("contextmenu", contextmenu);
    canvas.addEventListener("dblclick", dblclick);
    canvas.addEventListener("dragover", dragover);
    canvas.addEventListener("drop", drop);
    canvas.addEventListener("pointerleave", leave);

    return () => {
      renderer.detach();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("contextmenu", contextmenu);
      canvas.removeEventListener("dblclick", dblclick);
      canvas.removeEventListener("dragover", dragover);
      canvas.removeEventListener("drop", drop);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, []);

  const cursor =
    editor.spaceDown || editor.tool === "pan"
      ? "grab"
      : editor.tool === "select"
        ? "default"
        : "crosshair";

  return <canvas ref={ref} className="editor-canvas" style={{ cursor }} tabIndex={-1} />;
}
