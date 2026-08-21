// Canvas renderer. Subscribes to all three stores and coalesces redraws through
// a single requestAnimationFrame. All drawing happens in image coordinates under
// a viewport transform; stroke widths / marker radii are divided by zoom so they
// stay constant in screen pixels.
import * as M from "./model";
import { docStore, editorStore, overlayStore, sameRef, type ItemRef } from "./store";
import type { SnapResult } from "./snap";
import { dist, polygonCentroid } from "./geometry";
import { poiColor, roomColor } from "./colors";

const COLORS = {
  bg: "#f4f3f1",
  wall: "#263238",
  door: "#8d6e63",
  nav: "#1e88e5",
  snap: "#00c853",
  selection: "#ff9100",
  hover: "#ffb74d",
  calib: "#6a1b9a",
};

const DIM = 0.22; // alpha for inactive layers

export class Renderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private unsubs: Array<() => void> = [];
  private imageCache = new Map<string, HTMLImageElement>();

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.unsubs = [
      docStore.subscribe(this.requestRedraw),
      editorStore.subscribe(this.requestRedraw),
      overlayStore.subscribe(this.requestRedraw),
    ];
    this.requestRedraw();
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
    this.ctx = null;
  }

  requestRedraw = (): void => {
    if (this.raf || !this.canvas) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  };

  private image(dataUrl: string): HTMLImageElement | null {
    let img = this.imageCache.get(dataUrl);
    if (!img) {
      img = new Image();
      img.onload = this.requestRedraw;
      img.src = dataUrl;
      this.imageCache.set(dataUrl, img);
      if (this.imageCache.size > 12) {
        // drop the oldest entry so replaced floor images don't accumulate
        const first = this.imageCache.keys().next().value;
        if (first && first !== dataUrl) this.imageCache.delete(first);
      }
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  private draw(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, bw, bh);

    const floor = M.findFloor(docStore.project, editorStore.floorId);
    if (!floor) return;

    const v = overlayStore.viewport;
    const z = v.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * v.x, dpr * v.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 1. floor image underlay
    if (floor.image) {
      const img = this.image(floor.image.dataUrl);
      if (img) {
        ctx.globalAlpha = editorStore.imageOpacity;
        ctx.drawImage(img, 0, 0, floor.image.width, floor.image.height);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = "#d5d2cc";
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(0, 0, floor.image.width, floor.image.height);
    }

    const layer = editorStore.layer;
    const wallsAlpha = layer === "walls" ? 1 : DIM;
    const navAlpha = layer === "nav" ? 1 : DIM;
    const poisAlpha = layer === "pois" ? 1 : DIM;

    // 2. room fills (belong visually to the walls layer)
    ctx.globalAlpha = 1;
    for (const room of Object.values(floor.rooms)) {
      const pts = room.loop.map((id) => floor.walls.nodes[id]).filter(Boolean);
      if (pts.length < 3 || pts.length !== room.loop.length) continue;
      const color = roomColor(room.id);
      ctx.beginPath();
      this.tracePath(ctx, pts, true);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.13 * wallsAlpha;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (layer === "walls" && z > 0.15) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.font = `${13 / z}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const c = polygonCentroid(pts);
        ctx.fillText(room.name, c.x, c.y);
        ctx.globalAlpha = 1;
      }
    }

    // 3. walls
    ctx.globalAlpha = wallsAlpha;
    for (const e of Object.values(floor.walls.edges)) {
      const A = floor.walls.nodes[e.a];
      const B = floor.walls.nodes[e.b];
      if (!A || !B) continue;
      if (e.kind === "door") {
        ctx.strokeStyle = COLORS.door;
        ctx.lineWidth = 2 / z;
        ctx.setLineDash([5 / z, 4 / z]);
      } else {
        ctx.strokeStyle = COLORS.wall;
        ctx.lineWidth = 2.5 / z;
        ctx.setLineDash(e.kind ? [10 / z, 3 / z] : []);
      }
      this.line(ctx, A, B);
    }
    ctx.setLineDash([]);
    if (layer === "walls") {
      ctx.fillStyle = COLORS.wall;
      for (const n of Object.values(floor.walls.nodes)) this.dot(ctx, n, 3.2 / z);
    }

    // 4. nav graph
    ctx.globalAlpha = navAlpha;
    ctx.strokeStyle = COLORS.nav;
    ctx.lineWidth = 2.5 / z;
    ctx.setLineDash([7 / z, 5 / z]);
    for (const e of Object.values(floor.nav.edges)) {
      const A = floor.nav.nodes[e.a];
      const B = floor.nav.nodes[e.b];
      if (A && B) this.line(ctx, A, B);
    }
    ctx.setLineDash([]);
    const linked = new Map<string, M.InterFloorEdge[]>();
    for (const l of M.linksTouchingFloor(docStore.project, floor.id)) {
      const node = l.from.floor === floor.id ? l.from.node : l.to.node;
      if (!linked.has(node)) linked.set(node, []);
      linked.get(node)!.push(l);
    }
    for (const n of Object.values(floor.nav.nodes)) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = COLORS.nav;
      ctx.lineWidth = 2 / z;
      this.dot(ctx, n, 4.2 / z, true);
      const links = linked.get(n.id);
      if (links) this.linkBadge(ctx, n, links, floor.id, z);
    }

    // 5. POIs (color-coded by type)
    ctx.globalAlpha = poisAlpha;
    for (const poi of Object.values(floor.pois)) {
      const color = poiColor(poi.type);
      if (poi.navNodeId) {
        const nn = floor.nav.nodes[poi.navNodeId];
        if (nn && dist(poi, nn) > 0.5) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1 / z;
          ctx.setLineDash([3 / z, 3 / z]);
          this.line(ctx, poi, nn);
          ctx.setLineDash([]);
        }
      }
      this.diamond(ctx, poi, 6 / z, color, poi.navNodeId ? COLORS.nav : "#ffffff");
      // Room-POIs are already labeled by their room fill.
      if (z > 0.35 && !poi.roomId) {
        ctx.fillStyle = color;
        ctx.font = `${11 / z}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(poi.name || poi.type, poi.x, poi.y + 9 / z);
      }
    }
    ctx.globalAlpha = 1;

    // 6. room preview (Room tool hover)
    if (overlayStore.roomPreview && overlayStore.roomPreview.length >= 3) {
      ctx.beginPath();
      this.tracePath(ctx, overlayStore.roomPreview, true);
      ctx.fillStyle = COLORS.snap;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS.snap;
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 7. in-progress chain rubber band + snap indicators
    this.drawChainAndSnap(ctx, floor, z);

    // 8. hover + selection highlights
    if (overlayStore.hover && !sameRef(overlayStore.hover, editorStore.selection)) {
      this.highlight(ctx, floor, overlayStore.hover, COLORS.hover, z);
    }
    if (editorStore.selection) {
      this.highlight(ctx, floor, editorStore.selection, COLORS.selection, z);
    }

    // 9. calibration line
    if (editorStore.tool === "calibrate" && editorStore.calibPoint && overlayStore.cursor) {
      const a = editorStore.calibPoint;
      const b = overlayStore.cursor;
      ctx.strokeStyle = COLORS.calib;
      ctx.lineWidth = 2 / z;
      this.line(ctx, a, b);
      ctx.fillStyle = COLORS.calib;
      this.dot(ctx, a, 3.5 / z);
      const px = dist(a, b);
      ctx.font = `${12 / z}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const m = floor.pxPerMeter ? ` = ${(px / floor.pxPerMeter).toFixed(2)} m` : "";
      ctx.fillText(`${px.toFixed(0)} px${m}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6 / z);
    }
  }

  private drawChainAndSnap(ctx: CanvasRenderingContext2D, floor: M.Floor, z: number): void {
    const snapRes = overlayStore.snapPreview;
    const anchorId = editorStore.chainAnchor;
    const layer = editorStore.layer;
    const g = layer === "nav" ? floor.nav : floor.walls;
    const anchor = anchorId ? g.nodes[anchorId] : null;

    if (anchor && snapRes) {
      const door = editorStore.doorMode && layer === "walls";
      ctx.strokeStyle = door ? COLORS.door : COLORS.snap;
      ctx.lineWidth = 2 / z;
      ctx.setLineDash(door ? [4 / z, 4 / z] : [8 / z, 5 / z]);
      this.line(ctx, anchor, snapRes.point);
      ctx.setLineDash([]);
    }
    if (anchor) {
      ctx.strokeStyle = COLORS.snap;
      ctx.lineWidth = 2 / z;
      this.dot(ctx, anchor, 6 / z, true, "transparent");
    }
    if (!snapRes) return;

    ctx.strokeStyle = COLORS.snap;
    ctx.fillStyle = COLORS.snap;
    ctx.lineWidth = 2 / z;
    const p = snapRes.point;
    switch (snapRes.kind) {
      case "node": {
        this.dot(ctx, p, 9 / z, true, "transparent");
        break;
      }
      case "poi": {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-8 / z, -8 / z, 16 / z, 16 / z);
        ctx.restore();
        break;
      }
      case "segment": {
        this.highlightEdge(ctx, floor, layer === "nav" ? "nav" : "walls", snapRes.edge, COLORS.snap, z);
        this.dot(ctx, p, 4 / z);
        break;
      }
      case "angle":
      case "angle-node":
      case "angle-segment": {
        if (anchor) {
          const dx = p.x - anchor.x;
          const dy = p.y - anchor.y;
          const len = Math.hypot(dx, dy) || 1;
          const ext = 60 / z;
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([4 / z, 4 / z]);
          ctx.lineWidth = 1 / z;
          this.line(ctx, anchor, {
            x: p.x + (dx / len) * ext,
            y: p.y + (dy / len) * ext,
          });
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        if (snapRes.kind === "angle-node") {
          const n = g.nodes[snapRes.alignNode];
          if (n) {
            ctx.setLineDash([3 / z, 3 / z]);
            ctx.lineWidth = 1 / z;
            this.line(ctx, p, n);
            ctx.setLineDash([]);
            this.dot(ctx, n, 5 / z, true, "transparent");
          }
        }
        if (snapRes.kind === "angle-segment") {
          this.highlightEdge(ctx, floor, layer === "nav" ? "nav" : "walls", snapRes.edge, COLORS.snap, z);
          const s = 5 / z;
          ctx.lineWidth = 2 / z;
          this.line(ctx, { x: p.x - s, y: p.y - s }, { x: p.x + s, y: p.y + s });
          this.line(ctx, { x: p.x - s, y: p.y + s }, { x: p.x + s, y: p.y - s });
        }
        this.dot(ctx, p, 4 / z);
        break;
      }
      case "none":
        break;
    }
  }

  private highlight(
    ctx: CanvasRenderingContext2D,
    floor: M.Floor,
    ref: ItemRef,
    color: string,
    z: number,
  ): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    switch (ref.kind) {
      case "node": {
        const g = ref.layer === "walls" ? floor.walls : floor.nav;
        const n = g.nodes[ref.id];
        if (n) {
          ctx.lineWidth = 2.5 / z;
          this.dot(ctx, n, 8 / z, true, "transparent");
        }
        break;
      }
      case "edge":
        this.highlightEdge(ctx, floor, ref.layer, ref.key, color, z);
        break;
      case "poi": {
        const poi = floor.pois[ref.id];
        if (poi) {
          ctx.lineWidth = 2.5 / z;
          ctx.save();
          ctx.translate(poi.x, poi.y);
          ctx.rotate(Math.PI / 4);
          ctx.strokeRect(-9 / z, -9 / z, 18 / z, 18 / z);
          ctx.restore();
        }
        break;
      }
      case "room": {
        const room = floor.rooms[ref.id];
        if (room) {
          const pts = room.loop.map((id) => floor.walls.nodes[id]).filter(Boolean);
          if (pts.length >= 3) {
            ctx.beginPath();
            this.tracePath(ctx, pts, true);
            ctx.lineWidth = 3 / z;
            ctx.stroke();
            ctx.globalAlpha = 0.08;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        }
        break;
      }
    }
  }

  private highlightEdge(
    ctx: CanvasRenderingContext2D,
    floor: M.Floor,
    layer: "walls" | "nav",
    key: string,
    color: string,
    z: number,
  ): void {
    const g = layer === "walls" ? floor.walls : floor.nav;
    const e = g.edges[key];
    if (!e) return;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    if (!A || !B) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4.5 / z;
    ctx.globalAlpha = 0.75;
    this.line(ctx, A, B);
    ctx.globalAlpha = 1;
  }

  private linkBadge(
    ctx: CanvasRenderingContext2D,
    n: M.GraphNode,
    links: M.InterFloorEdge[],
    floorId: string,
    z: number,
  ): void {
    ctx.strokeStyle = COLORS.nav;
    ctx.lineWidth = 1.5 / z;
    this.dot(ctx, n, 7.5 / z, true, "transparent");
    const labels = links.map((l) => {
      const outgoing = l.from.floor === floorId;
      const otherId = outgoing ? l.to.floor : l.from.floor;
      const idx = docStore.project.floors.findIndex((f) => f.id === otherId);
      const name = idx >= 0 ? `F${idx + 1}` : "?";
      const glyph = l.kind === "elevator" ? "◱" : l.kind === "escalator" ? "⤢" : "≣";
      const arrow = l.oneWay ? (outgoing ? "→" : "←") : "↔";
      return `${glyph}${arrow}${name}`;
    });
    ctx.fillStyle = COLORS.nav;
    ctx.font = `${10 / z}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(labels.join(" "), n.x, n.y - 10 / z);
  }

  private tracePath(ctx: CanvasRenderingContext2D, pts: M.Vec2[], close: boolean): void {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (close) ctx.closePath();
  }

  private line(ctx: CanvasRenderingContext2D, a: M.Vec2, b: M.Vec2): void {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  private dot(
    ctx: CanvasRenderingContext2D,
    p: M.Vec2,
    r: number,
    stroke = false,
    fill?: string,
  ): void {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (fill !== "transparent") {
      if (fill) ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) ctx.stroke();
  }

  private diamond(
    ctx: CanvasRenderingContext2D,
    p: M.Vec2,
    r: number,
    fill: string,
    stroke: string,
  ): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = fill;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = r / 4;
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

export const renderer = new Renderer();
