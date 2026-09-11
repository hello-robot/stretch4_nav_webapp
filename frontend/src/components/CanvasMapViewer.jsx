import { useEffect, useRef, useCallback } from 'react';

/**
 * 2D occupancy map viewer with pan/zoom and optional pose click-drag.
 *
 * grid: { info: { width, height, resolution, origin }, data: int8[] }
 *   or editor form: { width, height, resolution, origin, pixels: number[] }
 */
function normalizeGrid(grid) {
  if (!grid) return null;
  if (grid.info) {
    const { width, height, resolution, origin } = grid.info;
    let data = grid.data;
    if (typeof data === 'string') {
      // rosbridge may base64-encode int8 arrays in some configs; treat as unavailable
      return null;
    }
    return {
      width,
      height,
      resolution,
      originX: origin?.position?.x ?? 0,
      originY: origin?.position?.y ?? 0,
      data,
    };
  }
  if (grid.pixels) {
    return {
      width: grid.width,
      height: grid.height,
      resolution: grid.resolution ?? 0.05,
      originX: grid.origin?.[0] ?? 0,
      originY: grid.origin?.[1] ?? 0,
      data: grid.pixels,
    };
  }
  return null;
}

function occupancyColor(value, isPgm) {
  if (!isPgm) {
    if (value < 0) return [90, 90, 90];
    if (value >= 50) return [20, 20, 20];
    return [210, 210, 210];
  }
  if (value <= 10) return [20, 20, 20];
  if (value >= 250) return [210, 210, 210];
  return [100, 100, 100];
}

// Screen px within which a freehand click "snaps" to the first vertex to close.
const CLOSE_SNAP_PX = 10;

// How close to an edge counts as grabbing it, and the smallest box allowed.
const CROP_HANDLE_PX = 9;
const CROP_MIN_CELLS = 2;

/** Where a crop box sits on screen, as a plain {x, y, w, h} rectangle. */
function cropScreenRect(box, g, st, toScreen) {
  const bottomCell = g.height - box.top - box.height;
  const [ax, ay] = toScreen(box.left, bottomCell + box.height, g, st);
  const [bx, by] = toScreen(box.left + box.width, bottomCell, g, st);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/**
 * Which part of the box the pointer is over: a corner ('tl'), a single side
 * ('l'), or nothing. Corners win over sides so the overlap grabs both edges.
 */
function cropHandleAt(px, py, rect) {
  const nearL = Math.abs(px - rect.x) <= CROP_HANDLE_PX;
  const nearR = Math.abs(px - (rect.x + rect.w)) <= CROP_HANDLE_PX;
  const nearT = Math.abs(py - rect.y) <= CROP_HANDLE_PX;
  const nearB = Math.abs(py - (rect.y + rect.h)) <= CROP_HANDLE_PX;
  const spanX = px >= rect.x - CROP_HANDLE_PX && px <= rect.x + rect.w + CROP_HANDLE_PX;
  const spanY = py >= rect.y - CROP_HANDLE_PX && py <= rect.y + rect.h + CROP_HANDLE_PX;
  if (!spanX || !spanY) return null;
  if (nearT && nearL) return 'tl';
  if (nearT && nearR) return 'tr';
  if (nearB && nearL) return 'bl';
  if (nearB && nearR) return 'br';
  if (nearL) return 'l';
  if (nearR) return 'r';
  if (nearT) return 't';
  if (nearB) return 'b';
  return null;
}

const CROP_CURSORS = {
  l: 'ew-resize',
  r: 'ew-resize',
  t: 'ns-resize',
  b: 'ns-resize',
  tl: 'nwse-resize',
  br: 'nwse-resize',
  tr: 'nesw-resize',
  bl: 'nesw-resize',
};

/**
 * Move one or two sides of the box, leaving the others where they are. Works in
 * image coordinates; `cellY` arrives counted from the bottom, so it is flipped
 * to a row first.
 */
function resizeCropBox(box, handle, cellX, cellY, width, height) {
  const row = height - 1 - cellY;
  let { left, top } = box;
  let right = box.left + box.width; // exclusive
  let bottom = box.top + box.height; // exclusive
  if (handle.includes('l')) left = Math.min(Math.max(0, cellX), right - CROP_MIN_CELLS);
  if (handle.includes('r')) right = Math.max(Math.min(width, cellX + 1), left + CROP_MIN_CELLS);
  if (handle.includes('t')) top = Math.min(Math.max(0, row), bottom - CROP_MIN_CELLS);
  if (handle.includes('b')) bottom = Math.max(Math.min(height, row + 1), top + CROP_MIN_CELLS);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Two grid cells (cellY counted from the bottom, the way screenToWorld reports
 * them) -> a crop box in image coordinates (row 0 at the top), which is what
 * the transform endpoint takes.
 */
function cropBoxFromCells(a, b, width, height) {
  const left = Math.max(0, Math.min(a.cellX, b.cellX));
  const right = Math.min(width - 1, Math.max(a.cellX, b.cellX));
  const bottom = Math.max(0, Math.min(a.cellY, b.cellY));
  const top = Math.min(height - 1, Math.max(a.cellY, b.cellY));
  if (right < left || top < bottom) return null;
  return {
    left,
    top: height - 1 - top,
    width: right - left + 1,
    height: top - bottom + 1,
  };
}

function hexToRgb(hex, fallback = [61, 156, 240]) {
  const m = /^#?([\da-f]{6})$/i.exec(String(hex || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Shift a pending shape by whole cells. */
function translateShape(shape, dx, dy) {
  if (shape.kind === 'circle') return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
  if (shape.kind === 'rect') {
    return { ...shape, x0: shape.x0 + dx, y0: shape.y0 + dy, x1: shape.x1 + dx, y1: shape.y1 + dy };
  }
  return { ...shape, pts: shape.pts.map(([px, py]) => [px + dx, py + dy]) };
}

/** Move one or two sides of a pending rect (cells, y up; screen 't' = max y). */
function resizeShapeRect(orig, handle, cell) {
  let { x0, y0, x1, y1 } = orig;
  if (handle.includes('l')) x0 = Math.min(cell.cellX, x1);
  if (handle.includes('r')) x1 = Math.max(cell.cellX, x0);
  if (handle.includes('t')) y1 = Math.max(cell.cellY, y0);
  if (handle.includes('b')) y0 = Math.min(cell.cellY, y1);
  return { ...orig, x0, y0, x1, y1 };
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export default function MapViewer({
  grid,
  backgroundGrid,
  colorMode = 'occupancy',
  clickMode = 'view', // view | paint | shape
  onPaint,
  // Shape editing (circle / rect / freehand) with live preview.
  shapeTool = null, // 'circle' | 'rect' | 'freehand' | null
  shapeAnchor = null, // { cellX, cellY } first click for circle (center) / rect (corner)
  freehandPoints = null, // [[cellX, cellY], ...] vertices placed so far
  onShapeClick, // (cellX, cellY, nearStart) => void
  onShapeClose, // () => void  (double-click to finish freehand)
  brushSize = 2,
  paintValue = 254,
  // Semantic layer: [{ id, name, color }] — pixel value is the region id.
  semanticRegions = null,
  // Crop preview in *image* pixel coords (row 0 at the top), matching what the
  // backend's transform endpoint takes: { left, top, width, height }.
  cropBox = null,
  // Called with a new box (or null to clear) when clickMode is 'crop'.
  onCropRect,
  // True while the "Draw crop box" button is armed: clicks place the two
  // corners of a new box. Off, clicks and drags pan as usual.
  cropDrawArmed = false,
  onCropDrawDone,
  // "remove" dims the inside of the box (that part goes away); otherwise the
  // outside is dimmed (that part goes away).
  cropRemoveMode = false,
  // Shape objects (already rasterized into `grid`); clicking one selects it
  // for move/resize, reported back via the callbacks.
  shapes = [],
  selectedShapeId = null,
  onSelectShape,
  onShapeChange,
  onShapeEditStart,
  // Live preview of a pending rotation (degrees CCW); pixels turn on Apply.
  previewRotationDeg = 0,
  // Shows a button that fits the map back into the window.
  showRecenter = false,
  className = 'map-canvas',
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    dragMoved: false,
    lastX: 0,
    lastY: 0,
    downX: 0,
    downY: 0,
    hoverCell: null, // { cellX, cellY, sx, sy }
  });

  const screenToWorld = useCallback((sx, sy, g, st) => {
    const mx = (sx - st.offsetX) / st.scale;
    const my = g.height - (sy - st.offsetY) / st.scale;
    const wx = g.originX + mx * g.resolution;
    const wy = g.originY + my * g.resolution;
    return { x: wx, y: wy, cellX: Math.floor(mx), cellY: Math.floor(my) };
  }, []);

  // The rotation preview draws the map (and crop box) through ctx.rotate about
  // the map centre. Pointer coords must be mapped back into the unrotated frame
  // before any crop math, or clicks land rotated away from the cursor.
  const toUnrotated = useCallback(
    (sx, sy, g, st) => {
      if (!previewRotationDeg) return [sx, sy];
      const rcx = st.offsetX + (g.width * st.scale) / 2;
      const rcy = st.offsetY + (g.height * st.scale) / 2;
      const t = (previewRotationDeg * Math.PI) / 180;
      const dx = sx - rcx;
      const dy = sy - rcy;
      return [rcx + dx * Math.cos(t) - dy * Math.sin(t), rcy + dx * Math.sin(t) + dy * Math.cos(t)];
    },
    [previewRotationDeg]
  );

  // Cell (grid) coordinate -> screen px. Inverse of screenToWorld's cell math.
  const cellToScreen = useCallback((cellX, cellY, g, st) => {
    const sx = st.offsetX + cellX * st.scale;
    const sy = st.offsetY + (g.height - cellY) * st.scale;
    return [sx, sy];
  }, []);

  const drawShapePreview = useCallback(
    (ctx, g, st) => {
      const h = st.hoverCell;
      if (!h) return;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(90,190,255,0.95)';
      ctx.fillStyle = 'rgba(90,190,255,0.22)';

      if (shapeTool === 'circle' && shapeAnchor) {
        const [cx, cy] = cellToScreen(shapeAnchor.cellX, shapeAnchor.cellY, g, st);
        const rCells = Math.hypot(h.cellX - shapeAnchor.cellX, h.cellY - shapeAnchor.cellY);
        const rPix = rCells * st.scale;
        ctx.beginPath();
        ctx.arc(cx, cy, rPix, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(90,190,255,1)';
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#cfe8ff';
        ctx.font = '12px sans-serif';
        ctx.fillText(`r = ${Math.round(rCells)} px`, h.sx + 12, h.sy - 8);
      } else if (shapeTool === 'rect' && shapeAnchor) {
        const [ax, ay] = cellToScreen(shapeAnchor.cellX, shapeAnchor.cellY, g, st);
        const [bx, by] = cellToScreen(h.cellX, h.cellY, g, st);
        const x = Math.min(ax, bx);
        const y = Math.min(ay, by);
        const w = Math.abs(bx - ax);
        const ht = Math.abs(by - ay);
        ctx.fillRect(x, y, w, ht);
        ctx.strokeRect(x, y, w, ht);
        ctx.fillStyle = '#cfe8ff';
        ctx.font = '12px sans-serif';
        ctx.fillText(
          `${Math.abs(h.cellX - shapeAnchor.cellX)} × ${Math.abs(h.cellY - shapeAnchor.cellY)} px`,
          h.sx + 12,
          h.sy - 8
        );
      } else if (shapeTool === 'freehand') {
        const pts = freehandPoints || [];
        if (pts.length > 0) {
          const [x0, y0] = cellToScreen(pts[0][0], pts[0][1], g, st);
          const near = pts.length >= 3 && Math.hypot(h.sx - x0, h.sy - y0) <= CLOSE_SNAP_PX;

          // If hovering over the start vertex, preview the filled closed polygon.
          if (near) {
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            for (let i = 1; i < pts.length; i++) {
              const [px, py] = cellToScreen(pts[i][0], pts[i][1], g, st);
              ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(90,255,150,0.22)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(90,255,150,0.95)';
            ctx.stroke();
          } else {
            // Open path + rubber-band line to the cursor.
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            for (let i = 1; i < pts.length; i++) {
              const [px, py] = cellToScreen(pts[i][0], pts[i][1], g, st);
              ctx.lineTo(px, py);
            }
            ctx.lineTo(h.sx, h.sy);
            ctx.stroke();
          }

          // Vertices.
          for (const p of pts) {
            const [px, py] = cellToScreen(p[0], p[1], g, st);
            ctx.fillStyle = 'rgba(90,190,255,1)';
            ctx.beginPath();
            ctx.arc(px, py, 3, 0, 2 * Math.PI);
            ctx.fill();
          }
          // Emphasize the start vertex (green when it will close).
          ctx.fillStyle = near ? 'rgba(90,255,150,1)' : 'rgba(90,190,255,1)';
          ctx.beginPath();
          ctx.arc(x0, y0, near ? 6 : 4, 0, 2 * Math.PI);
          ctx.fill();
          if (pts.length >= 3) {
            ctx.fillStyle = '#cfe8ff';
            ctx.font = '12px sans-serif';
            ctx.fillText(
              near ? 'click to close & fill' : 'click start dot to close',
              h.sx + 12,
              h.sy - 8
            );
          }
        }
      }
      ctx.restore();
    },
    [shapeTool, shapeAnchor, freehandPoints, cellToScreen]
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const g = normalizeGrid(grid);
    const bg = normalizeGrid(backgroundGrid);
    const st = stateRef.current;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.fillStyle = '#0a0e12';
    ctx.fillRect(0, 0, cw, ch);
    const primary = bg || g;
    if (!primary || !primary.data || !primary.width) return;

    // id -> [r,g,b] for the semantic layer; ids are the raw pixel values.
    const palette = {};
    for (const region of semanticRegions || []) {
      palette[region.id] = hexToRgb(region.color);
    }

    const drawRaster = (source, mode, options = {}) => {
      const { overlay = false } = options;
      const img = ctx.createImageData(source.width, source.height);
      const isPgm = mode !== 'occupancy' || (source.data.length && Math.max(...source.data.slice(0, 2000)) > 100);
      for (let i = 0; i < source.data.length && i < source.width * source.height; i++) {
        let r;
        let green;
        let b;
        let a = 255;
        if (mode === 'occupancy') {
          [r, green, b] = occupancyColor(source.data[i], isPgm);
        } else if (mode === 'keepout') {
          const v = source.data[i];
          if (overlay) {
            if (v >= 50) a = 0;
            [r, green, b] = [120, 120, 120];
          } else if (v < 50) {
            [r, green, b] = [120, 120, 120];
          } else {
            [r, green, b] = [210, 210, 210];
          }
        } else if (mode === 'binary') {
          // Marked / not marked, over the occupancy map. Violet rather than
          // keepout's grey so the two layers never read as the same thing.
          const v = source.data[i];
          const marked = v < 230;
          if (overlay) a = marked ? 155 : 0;
          [r, green, b] = marked ? [176, 124, 240] : [210, 210, 210];
        } else if (mode === 'semantic') {
          const v = source.data[i];
          const rgb = v > 0 ? palette[v] : null;
          if (!rgb) {
            // Unlabelled: let the occupancy map underneath show through.
            a = overlay ? 0 : 255;
            [r, green, b] = [26, 34, 44];
          } else {
            [r, green, b] = rgb;
            a = overlay ? 150 : 255;
          }
        } else {
          const v = Math.max(0, Math.min(255, source.data[i]));
          [r, green, b] = [v, v, v];
          if (overlay) a = v >= 250 ? 0 : 185;
        }
        const row = Math.floor(i / source.width);
        const col = i % source.width;
        // flip Y for display
        const di = ((source.height - 1 - row) * source.width + col) * 4;
        img.data[di] = r;
        img.data[di + 1] = green;
        img.data[di + 2] = b;
        img.data[di + 3] = a;
      }
      const off = document.createElement('canvas');
      off.width = source.width;
      off.height = source.height;
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.drawImage(off, st.offsetX, st.offsetY, source.width * st.scale, source.height * st.scale);
    };

    // Fit on first draw
    if (st.scale === 1 && st.offsetX === 0 && st.offsetY === 0) {
      const fit = Math.min(cw / primary.width, ch / primary.height) * 0.92;
      st.scale = fit;
      st.offsetX = (cw - primary.width * fit) / 2;
      st.offsetY = (ch - primary.height * fit) / 2;
    }

    ctx.imageSmoothingEnabled = false;

    // A pending rotation is shown by turning the whole picture about the map's
    // centre — the same point the real transform turns about. Canvas angles run
    // clockwise because y points down, so a counter-clockwise map rotation is a
    // negative canvas angle.
    const rotating = Boolean(previewRotationDeg);
    if (rotating) {
      const rcx = st.offsetX + (primary.width * st.scale) / 2;
      const rcy = st.offsetY + (primary.height * st.scale) / 2;
      ctx.save();
      ctx.translate(rcx, rcy);
      ctx.rotate((-previewRotationDeg * Math.PI) / 180);
      ctx.translate(-rcx, -rcy);
    }

    if (bg) drawRaster(bg, 'occupancy');
    if (g) drawRaster(g, colorMode, { overlay: Boolean(bg) });

    // What a crop would keep: everything outside the box is dimmed, so the
    // "this is what you are about to throw away" reading is immediate. While a
    // box is being dragged out, the in-progress one wins over the committed one.
    const liveBox =
      st.cropAnchor && st.cropHover && primary.width
        ? cropBoxFromCells(st.cropAnchor, st.cropHover, primary.width, primary.height)
        : cropBox;
    if (liveBox && primary.height) {
      const { x, y, w, h } = cropScreenRect(liveBox, primary, st, cellToScreen);
      const accent = cropRemoveMode ? 'rgba(232,93,93,0.95)' : 'rgba(90,190,255,0.95)';
      ctx.save();
      if (cropRemoveMode) {
        // The inside goes away.
        ctx.fillStyle = 'rgba(232,93,93,0.30)';
        ctx.fillRect(x, y, w, h);
      } else {
        // The outside goes away. Oversized so the dim survives the preview
        // rotation turning this path with it.
        ctx.fillStyle = 'rgba(10,14,18,0.66)';
        ctx.beginPath();
        const span = (cw + ch) * 2;
        ctx.rect(-span, -span, span * 3, span * 3);
        ctx.rect(x, y, w, h);
        ctx.fill('evenodd');
      }
      ctx.strokeStyle = accent;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // A handle per corner and side, so movable edges are visible. Hidden
      // while armed: those clicks place a new box instead of resizing.
      if (cropBox && !st.cropAnchor && !cropDrawArmed) {
        ctx.setLineDash([]);
        ctx.fillStyle = accent;
        const s = 7;
        const spots = [
          [x, y], [x + w / 2, y], [x + w, y],
          [x, y + h / 2], [x + w, y + h / 2],
          [x, y + h], [x + w / 2, y + h], [x + w, y + h],
        ];
        for (const [hx, hy] of spots) ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
      }
      ctx.restore();
    }

    if (rotating) ctx.restore();

    // Selection overlay: the shape itself is already in the raster, so this is
    // just the outline + grab handles.
    const sel = shapes.find((s) => s.id === selectedShapeId);
    if (clickMode === 'shape' && sel) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(90,190,255,0.95)';
      ctx.fillStyle = 'rgba(90,190,255,0.12)';
      const dots = [];
      if (sel.kind === 'circle') {
        // Fill covers cells within r of the centre cell, so draw about its centre.
        const [sx, sy] = cellToScreen(sel.cx + 0.5, sel.cy + 0.5, primary, st);
        const rPx = sel.r * st.scale;
        ctx.beginPath();
        ctx.arc(sx, sy, rPx, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        dots.push([sx, sy], [sx + rPx, sy], [sx - rPx, sy], [sx, sy + rPx], [sx, sy - rPx]);
      } else if (sel.kind === 'rect') {
        // +1: the fill paints x0..x1 / y0..y1 inclusive.
        const [ax, ay] = cellToScreen(sel.x0, sel.y0, primary, st);
        const [bx, by] = cellToScreen(sel.x1 + 1, sel.y1 + 1, primary, st);
        const x = Math.min(ax, bx);
        const y = Math.min(ay, by);
        const w = Math.abs(bx - ax);
        const h = Math.abs(by - ay);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        dots.push(
          [x, y], [x + w / 2, y], [x + w, y],
          [x, y + h / 2], [x + w, y + h / 2],
          [x, y + h], [x + w / 2, y + h], [x + w, y + h]
        );
      } else {
        ctx.beginPath();
        sel.pts.forEach(([px, py], i) => {
          const [sx, sy] = cellToScreen(px, py, primary, st);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
          dots.push([sx, sy]);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(90,190,255,1)';
      for (const [hx, hy] of dots) ctx.fillRect(hx - 4, hy - 4, 8, 8);
      ctx.restore();
    }

    if (clickMode === 'shape') drawShapePreview(ctx, primary, st);
  }, [
    grid,
    backgroundGrid,
    colorMode,
    clickMode,
    drawShapePreview,
    semanticRegions,
    cropBox,
    cropRemoveMode,
    shapes,
    selectedShapeId,
    cellToScreen,
    previewRotationDeg,
    cropDrawArmed,
  ]);

  // Leaving crop mode (or disarming the button) must not strand a half-placed
  // corner that would jump into a box on the next unrelated click.
  useEffect(() => {
    if (clickMode !== 'crop' || !cropDrawArmed) {
      stateRef.current.cropAnchor = null;
    }
    if (clickMode !== 'crop' && canvasRef.current) {
      canvasRef.current.style.cursor = '';
    }
  }, [clickMode, cropDrawArmed]);

  const selectedShape = shapes.find((s) => s.id === selectedShapeId) || null;

  // A deleted/deselected shape must not be resurrected by a drag in flight.
  useEffect(() => {
    if (!selectedShape) stateRef.current.shapeDrag = null;
  }, [selectedShape]);

  // What part of a shape is under the pointer (screen px). Handles are only
  // offered for the selected shape; any hit on another shape reads as its body.
  const shapeHitAt = useCallback(
    (shape, x, y, g, st, { withHandles = true } = {}) => {
      const grab = 8;
      if (shape.kind === 'circle') {
        const [sx, sy] = cellToScreen(shape.cx + 0.5, shape.cy + 0.5, g, st);
        const d = Math.hypot(x - sx, y - sy);
        const rPx = shape.r * st.scale;
        if (withHandles && d > grab && Math.abs(d - rPx) <= grab) return { mode: 'rim' };
        if (d < rPx + (withHandles ? grab : 0)) return { mode: 'move' };
        return null;
      }
      if (shape.kind === 'rect') {
        const [ax, ay] = cellToScreen(shape.x0, shape.y0, g, st);
        const [bx, by] = cellToScreen(shape.x1 + 1, shape.y1 + 1, g, st);
        const rect = {
          x: Math.min(ax, bx),
          y: Math.min(ay, by),
          w: Math.abs(bx - ax),
          h: Math.abs(by - ay),
        };
        if (withHandles) {
          const handle = cropHandleAt(x, y, rect);
          if (handle) return { mode: 'rect-handle', handle };
        }
        if (x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h) {
          return { mode: 'move' };
        }
        return null;
      }
      const screenPts = shape.pts.map(([px, py]) => cellToScreen(px, py, g, st));
      if (withHandles) {
        for (let i = 0; i < screenPts.length; i++) {
          if (Math.hypot(x - screenPts[i][0], y - screenPts[i][1]) <= grab) {
            return { mode: 'vertex', index: i };
          }
        }
      }
      if (pointInPolygon(x, y, screenPts)) return { mode: 'move' };
      return null;
    },
    [cellToScreen]
  );

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  const onWheel = (e) => {
    e.preventDefault();
    const st = stateRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    st.offsetX = mx - (mx - st.offsetX) * factor;
    st.offsetY = my - (my - st.offsetY) * factor;
    st.scale *= factor;
    draw();
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    canvas.setPointerCapture(e.pointerId);
    const st = stateRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    st.dragging = true;
    st.dragMoved = false;
    st.lastX = x;
    st.lastY = y;
    st.downX = x;
    st.downY = y;
    const g = normalizeGrid(grid);
    if (!g) return;
    if (clickMode === 'paint' && onPaint) {
      const w = screenToWorld(x, y, g, st);
      onPaint(w.cellX, w.cellY, paintValue, brushSize);
    } else if (
      clickMode === 'shape' &&
      shapes.length &&
      e.button === 0 &&
      // Mid-placement clicks belong to the new shape, not existing ones.
      !shapeAnchor &&
      !(freehandPoints && freehandPoints.length)
    ) {
      const w = screenToWorld(x, y, g, st);
      const beginDrag = (shape, hit) => {
        st.shapeDrag = {
          ...hit,
          startCell: { cellX: w.cellX, cellY: w.cellY },
          orig: JSON.parse(JSON.stringify(shape)),
          pushed: false,
        };
      };
      // Selected shape first (its handles win), then topmost other shape:
      // press selects it and starts a move in one gesture.
      const selHit = selectedShape ? shapeHitAt(selectedShape, x, y, g, st) : null;
      if (selHit) {
        beginDrag(selectedShape, selHit);
      } else {
        for (let i = shapes.length - 1; i >= 0; i--) {
          const s = shapes[i];
          if (s.id === selectedShapeId) continue;
          if (shapeHitAt(s, x, y, g, st, { withHandles: false })) {
            onSelectShape?.(s.id);
            beginDrag(s, { mode: 'move' });
            break;
          }
        }
      }
    } else if (clickMode === 'crop' && e.button === 0) {
      // Grabbing a side of an existing box beats panning. Disabled while armed:
      // those clicks place the new box.
      if (cropBox && !cropDrawArmed) {
        const [ux, uy] = toUnrotated(x, y, g, st);
        const handle = cropHandleAt(ux, uy, cropScreenRect(cropBox, g, st, cellToScreen));
        if (handle) {
          st.cropHandle = handle;
          canvasRef.current.style.cursor = CROP_CURSORS[handle];
        }
      }
    }
    // shape mode: a plain click is committed on pointerup (so drags can pan).
  };

  const onPointerMove = (e) => {
    const st = stateRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Track hover cell for the live shape preview (fires with no button held too).
    if (clickMode === 'shape') {
      const g = normalizeGrid(grid);
      if (g) {
        const w = screenToWorld(x, y, g, st);
        st.hoverCell = { cellX: w.cellX, cellY: w.cellY, sx: x, sy: y };
        // Cursor shows what a press would grab. Same mid-placement guard as
        // pointerdown so it never promises a grab a press would refuse.
        if (!st.dragging && shapes.length && !shapeAnchor && !(freehandPoints && freehandPoints.length)) {
          const selHit = selectedShape ? shapeHitAt(selectedShape, x, y, g, st) : null;
          const otherHit =
            !selHit &&
            shapes.some(
              (s) => s.id !== selectedShapeId && shapeHitAt(s, x, y, g, st, { withHandles: false })
            );
          canvasRef.current.style.cursor = selHit
            ? selHit.mode === 'rect-handle'
              ? CROP_CURSORS[selHit.handle]
              : selHit.mode === 'move'
                ? 'move'
                : 'pointer'
            : otherHit
              ? 'move'
              : '';
        } else if (!st.dragging) {
          canvasRef.current.style.cursor = '';
        }
      }
    }

    // Dragging a shape (move / rim / vertex / rect edge).
    if (st.dragging && st.shapeDrag) {
      const g = normalizeGrid(grid);
      const d = st.shapeDrag;
      const stillThere = shapes.some((s) => s.id === d.orig?.id);
      if (g && onShapeChange && stillThere) {
        const w = screenToWorld(x, y, g, st);
        let next;
        let changed;
        if (d.mode === 'move') {
          const dx = w.cellX - d.startCell.cellX;
          const dy = w.cellY - d.startCell.cellY;
          next = translateShape(d.orig, dx, dy);
          changed = dx !== 0 || dy !== 0;
        } else if (d.mode === 'rim') {
          const r = Math.max(1, Math.round(Math.hypot(w.cellX - d.orig.cx, w.cellY - d.orig.cy)));
          next = { ...d.orig, r };
          changed = r !== d.orig.r;
        } else if (d.mode === 'vertex') {
          next = {
            ...d.orig,
            pts: d.orig.pts.map((p, i) => (i === d.index ? [w.cellX, w.cellY] : p)),
          };
          const [px, py] = d.orig.pts[d.index];
          changed = px !== w.cellX || py !== w.cellY;
        } else {
          next = resizeShapeRect(d.orig, d.handle, w);
          changed =
            next.x0 !== d.orig.x0 || next.y0 !== d.orig.y0 ||
            next.x1 !== d.orig.x1 || next.y1 !== d.orig.y1;
        }
        // A same-cell wiggle is a click, not an edit: no snapshot, no dirty.
        // Once a real change happened, keep emitting so dragging back to the
        // start restores the original geometry.
        if (changed || d.pushed) {
          st.dragMoved = true;
          if (!d.pushed) {
            onShapeEditStart?.();
            d.pushed = true;
          }
          onShapeChange(next);
        }
      }
      st.lastX = x;
      st.lastY = y;
      return;
    }

    // Crop mode: cursor tells you which side you are about to grab, and a
    // rubber band follows while a new box is being placed.
    if (clickMode === 'crop') {
      const g = normalizeGrid(grid);
      if (g) {
        const [ux, uy] = toUnrotated(x, y, g, st);
        const w = screenToWorld(ux, uy, g, st);
        st.cropHover = { cellX: w.cellX, cellY: w.cellY };
        if (!st.cropHandle) {
          const over =
            cropBox && !cropDrawArmed
              ? cropHandleAt(ux, uy, cropScreenRect(cropBox, g, st, cellToScreen))
              : null;
          canvasRef.current.style.cursor = over
            ? CROP_CURSORS[over]
            : cropDrawArmed
              ? 'crosshair'
              : 'grab';
        }
        if (st.cropAnchor) draw(); // rubber band follows the cursor
      }
    }

    if (st.dragging && st.cropHandle) {
      const g = normalizeGrid(grid);
      if (g && cropBox) {
        const [ux, uy] = toUnrotated(x, y, g, st);
        const w = screenToWorld(ux, uy, g, st);
        st.dragMoved = true;
        onCropRect?.(
          resizeCropBox(cropBox, st.cropHandle, w.cellX, w.cellY, g.width, g.height)
        );
      }
      st.lastX = x;
      st.lastY = y;
    } else if (st.dragging) {
      const dx = x - st.lastX;
      const dy = y - st.lastY;
      if (Math.hypot(x - st.downX, y - st.downY) > 3) st.dragMoved = true;
      if (
        clickMode === 'view' ||
        clickMode === 'shape' ||
        clickMode === 'crop' ||
        (clickMode === 'paint' && e.buttons === 0)
      ) {
        st.offsetX += dx;
        st.offsetY += dy;
        draw();
      } else if (clickMode === 'paint' && onPaint) {
        const g = normalizeGrid(grid);
        if (g) {
          const w = screenToWorld(x, y, g, st);
          onPaint(w.cellX, w.cellY, paintValue, brushSize);
        }
      }
      st.lastX = x;
      st.lastY = y;
    } else if (clickMode === 'shape') {
      // Hovering (no button): redraw so the preview follows the cursor.
      draw();
    }
  };

  const onPointerUp = (e) => {
    const st = stateRef.current;
    if (!st.dragging) return;
    st.dragging = false;
    const g = normalizeGrid(grid);
    if (!g) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (st.shapeDrag) {
      st.shapeDrag = null;
      return;
    }

    if (st.cropHandle) {
      st.cropHandle = null;
      draw();
      return;
    }

    // Placing a new box: first click drops a corner, second click sets it.
    if (clickMode === 'crop' && cropDrawArmed && !st.dragMoved) {
      const [ux, uy] = toUnrotated(x, y, g, st);
      const w = screenToWorld(ux, uy, g, st);
      if (!st.cropAnchor) {
        st.cropAnchor = { cellX: w.cellX, cellY: w.cellY };
        draw();
        return;
      }
      const box = cropBoxFromCells(st.cropAnchor, w, g.width, g.height);
      st.cropAnchor = null;
      if (box && box.width >= CROP_MIN_CELLS && box.height >= CROP_MIN_CELLS) {
        onCropRect?.(box);
        onCropDrawDone?.();
      }
      draw();
      return;
    }

    if (clickMode === 'shape' && !st.dragMoved && onShapeClick) {
      // A click (not a pan) places a shape point.
      const w = screenToWorld(x, y, g, st);
      let nearStart = false;
      if (shapeTool === 'freehand' && freehandPoints && freehandPoints.length >= 3) {
        const [sx0, sy0] = cellToScreen(freehandPoints[0][0], freehandPoints[0][1], g, st);
        if (Math.hypot(x - sx0, y - sy0) <= CLOSE_SNAP_PX) nearStart = true;
      }
      onShapeClick(w.cellX, w.cellY, nearStart);
    }
  };

  const onDoubleClick = () => {
    if (clickMode === 'shape' && shapeTool === 'freehand' && onShapeClose) onShapeClose();
  };

  const onPointerLeave = () => {
    const st = stateRef.current;
    if (clickMode === 'shape' && st.hoverCell) {
      st.hoverCell = null;
      draw();
    }
  };

  const onPointerCancel = () => {
    const st = stateRef.current;
    st.dragging = false;
    st.shapeDrag = null;
    st.cropHandle = null;
  };

  const recenter = () => {
    const canvas = canvasRef.current;
    const g = normalizeGrid(grid) || normalizeGrid(backgroundGrid);
    if (!canvas || !g) return;
    const st = stateRef.current;
    const fit = Math.min(canvas.clientWidth / g.width, canvas.clientHeight / g.height) * 0.92;
    st.scale = fit;
    st.offsetX = (canvas.clientWidth - g.width * fit) / 2;
    st.offsetY = (canvas.clientHeight - g.height * fit) / 2;
    draw();
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className={className}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onPointerLeave={onPointerLeave}
      />
      {showRecenter && (
        <button
          type="button"
          className="map-recenter"
          onClick={recenter}
          title="Fit the whole map in the window"
        >
          ⌖ Recenter
        </button>
      )}
    </>
  );
}

export { normalizeGrid };
