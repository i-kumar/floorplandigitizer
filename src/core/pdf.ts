// PDF + image import. PDFs are rasterized to PNG dataURLs via pdf.js — all drawing
// coordinates live in the rasterized image's pixel space, so the render scale is
// deterministic (fixed target long edge) to keep re-imports reproducible.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { FloorImage } from "./model";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Rasterize at a real print resolution rather than a fixed pixel edge: a letter
// page comes out ~3300px, a large-format Arch D sheet gets the full cap instead
// of a blurry 83 DPI. The cap guards canvas memory on huge sheets.
export const RASTER_DPI = 300; // PDF user units are 1/72in, so scale = DPI / 72
export const RASTER_MAX_EDGE = 8000; // px, long edge

export interface PdfHandle {
  doc: pdfjs.PDFDocumentProxy;
  pageCount: number;
  fileName: string;
}

export async function openPdf(file: File): Promise<PdfHandle> {
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  return { doc, pageCount: doc.numPages, fileName: file.name };
}

async function renderPageToCanvas(
  pd: PdfHandle,
  pageNo: number,
  targetLongEdge?: number, // set → fixed pixel edge (thumbnails); unset → RASTER_DPI
): Promise<HTMLCanvasElement> {
  const page = await pd.doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const longEdge = Math.max(vp1.width, vp1.height);
  let scale: number;
  if (targetLongEdge != null) {
    scale = targetLongEdge / longEdge;
  } else {
    scale = RASTER_DPI / 72;
    if (longEdge * scale > RASTER_MAX_EDGE) scale = RASTER_MAX_EDGE / longEdge;
  }
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

export async function renderPdfPage(pd: PdfHandle, pageNo: number): Promise<FloorImage> {
  const canvas = await renderPageToCanvas(pd, pageNo);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    source: { fileName: pd.fileName, page: pageNo },
  };
}

export async function renderPdfThumb(pd: PdfHandle, pageNo: number): Promise<string> {
  const canvas = await renderPageToCanvas(pd, pageNo, 220);
  return canvas.toDataURL("image/png");
}

export async function loadImageFile(file: File): Promise<FloorImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image"));
    el.src = dataUrl;
  });
  return {
    dataUrl,
    width: img.naturalWidth,
    height: img.naturalHeight,
    source: { fileName: file.name },
  };
}
