/**
 * Pure rasterizers for the editor's shape objects.
 * Cell coords, y counted from the bottom; same cell coverage the old
 * immediate-fill tools produced.
 */

export function fillCircleInto(pixels, W, H, cx, cy, r, value) {
  if (r <= 0) return;
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(H - 1, cy + r);
  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(W - 1, cx + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) pixels[y * W + x] = value;
    }
  }
}

export function fillRectInto(pixels, W, H, x0, y0, x1, y1, value) {
  const minX = Math.max(0, Math.min(x0, x1));
  const maxX = Math.min(W - 1, Math.max(x0, x1));
  const minY = Math.max(0, Math.min(y0, y1));
  const maxY = Math.min(H - 1, Math.max(y0, y1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) pixels[y * W + x] = value;
  }
}

// Even-odd scanline fill, sampled at cell centers.
export function fillPolygonInto(pixels, W, H, pts, value) {
  if (pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, py] of pts) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        const t = (yc - y1) / (y2 - y1);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xStart = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xEnd = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xStart; x <= xEnd; x++) pixels[y * W + x] = value;
    }
  }
}

/** Base pixels + shape objects (in order) -> flattened copy. */
export function rasterizeShapes(base, W, H, shapes) {
  const out = base.slice();
  for (const s of shapes || []) {
    if (s.kind === 'circle') fillCircleInto(out, W, H, s.cx, s.cy, s.r, s.value);
    else if (s.kind === 'rect') fillRectInto(out, W, H, s.x0, s.y0, s.x1, s.y1, s.value);
    else if (s.kind === 'poly') fillPolygonInto(out, W, H, s.pts, s.value);
  }
  return out;
}
