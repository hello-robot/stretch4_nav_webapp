import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapViewer from './CanvasMapViewer';
import { rasterizeShapes } from '../utils/rasterizeShapes';

const SHAPE_TOOLS = ['circle', 'rect', 'freehand'];

// The grey a binary-filter zone is painted with. Anything below ~229 trips
// BinaryFilter at its usual flip_threshold; this is the value already proven on
// the robot's own mask, so a mask drawn here behaves like one drawn by hand.
const BINARY_ON = 153;

const TOOLS = [
  { id: 'brush', label: 'Brush', title: 'Paint free-hand. Drag to draw.' },
  { id: 'erase', label: 'Erase', title: 'Rub the layer back out. Drag to erase.' },
  { id: 'circle', label: 'Circle', title: 'Click the centre, then click again to set the radius.' },
  { id: 'rect', label: 'Rectangle', title: 'Click one corner, then click the opposite corner.' },
  { id: 'freehand', label: 'Polygon', title: 'Click each corner, then close the outline to fill it.' },
  { id: 'view', label: 'Pan', title: 'Move the map: drag to pan, scroll to zoom. Paints nothing.' },
];

/**
 * Pixel + shape editor.
 *
 * Shapes are objects, not strokes: they appear painted the moment they are
 * placed, but stay clickable — select to move, resize, or delete, even after
 * saving.
 */
export default function MapLayerEditor({
  layerData,
  backgroundLayerData,
  // Changes whenever the page loads a fresh buffer; resets undo/shape state.
  resetVersion = 0,
  colorMode = 'occupancy',
  onChange,
  // Semantic layer: the named regions and which one the brush is filling in.
  semanticRegions = null,
  activeRegionId = 0,
  // Crop mode borrows the rectangle tool: the box is reported back instead of
  // being painted into the pixels.
  cropMode = false,
  cropBox = null,
  onCropRect,
  cropDrawArmed = false,
  onCropDrawDone,
  cropRemoveMode = false,
  previewRotationDeg = 0,
}) {
  const [tool, setTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(3);

  const [speedPct, setSpeedPct] = useState(40);

  // Per-layer pixel values (0..255):
  //  - occupancy: brush = wall (0),      erase = free (254)
  //  - keepout:   brush = keep-out (0),  erase = free (255)
  //  - speed:     brush = speedPct -> gray (white = full speed = no limit),
  //               erase = full speed (white, 255)
  //  - semantic:  brush = the selected region's id, erase = unlabelled (0)
  //  - binary:    brush = 153, the grey that trips BinaryFilter; erase = 255
  const paintValueFor = (mode) => {
    if (mode === 'speed') return Math.round((speedPct / 100) * 255);
    if (mode === 'semantic') return activeRegionId;
    if (mode === 'binary') return BINARY_ON;
    return 0; // occupancy wall / keepout lethal
  };
  const eraseValueFor = (mode) => {
    if (mode === 'occupancy') return 254;
    if (mode === 'semantic') return 0;
    return 255; // keepout free / speed full / binary state unchanged
  };

  // In-progress shape placement.
  const [shapeAnchor, setShapeAnchor] = useState(null); // { cellX, cellY }
  const [freehandPts, setFreehandPts] = useState([]); // [[cellX, cellY], ...]

  // Shape objects over the base raster. Each carries the paint value it was
  // created with, so a kitchen region stays the kitchen when moved later.
  const [shapes, setShapes] = useState([]);
  const shapesRef = useRef([]);
  const [selectedId, setSelectedId] = useState(null);
  const shapeIdRef = useRef(1);
  // Raster beneath the shapes; brush/erase paint here.
  const baseRef = useRef(null);
  // Last flattened array handed to onChange — anything else arriving in
  // layerData is an external edit and gets adopted as the new base.
  const lastEmittedRef = useRef(null);

  const setShapesAll = (next) => {
    shapesRef.current = next;
    setShapes(next);
  };

  const history = useRef([]); // entries: { base, shapes }
  const segRef = useRef(null);
  const strokeActive = useRef(false);
  const [canUndo, setCanUndo] = useState(false);

  const clearShape = useCallback(() => {
    setShapeAnchor(null);
    setFreehandPts([]);
  }, []);

  // Reset undo history + any in-progress placement on every fresh load
  // (resetVersion bumps on map switch, layer switch, and after crop/rotate).
  // Undo snapshots from one buffer must never be poppable into another.
  useEffect(() => {
    history.current = [];
    strokeActive.current = false;
    setCanUndo(false);
    clearShape();
    setSelectedId(null);
  }, [resetVersion, colorMode, clearShape]);

  // Adopt externally-changed pixels as the new base. Fires on every fresh load
  // and on page-side edits (e.g. deleting a room clears its pixels); shapes are
  // flattened away by those paths, so they reset here too.
  useEffect(() => {
    const adopt = () => {
      setShapesAll([]);
      setSelectedId(null);
      // The old buffer's undo snapshots would resurrect pixels the external
      // edit just removed (e.g. a deleted room's ids).
      history.current = [];
      strokeActive.current = false;
      setCanUndo(false);
    };
    if (!layerData?.pixels) {
      baseRef.current = null;
      lastEmittedRef.current = null;
      adopt();
      return;
    }
    if (layerData.pixels !== lastEmittedRef.current) {
      baseRef.current = layerData.pixels.slice();
      adopt();
    }
  }, [layerData]);

  // Crop mode takes the canvas; drop any half-done placement, keep the shapes.
  useEffect(() => {
    if (cropMode) {
      clearShape();
      setSelectedId(null);
    }
  }, [cropMode, clearShape]);

  const grid = useMemo(() => {
    if (!layerData) return null;
    return {
      width: layerData.width,
      height: layerData.height,
      resolution: layerData.resolution,
      origin: layerData.origin,
      pixels: layerData.pixels,
    };
  }, [layerData]);

  const backgroundGrid = useMemo(() => {
    if (!backgroundLayerData || colorMode === 'occupancy') return null;
    return {
      width: backgroundLayerData.width,
      height: backgroundLayerData.height,
      resolution: backgroundLayerData.resolution,
      origin: backgroundLayerData.origin,
      pixels: backgroundLayerData.pixels,
    };
  }, [backgroundLayerData, colorMode]);

  // Flatten base + shapes and push the result up; the page's layerData.pixels
  // is therefore always savable as-is.
  const emit = (shapesArr = shapesRef.current) => {
    if (!layerData || !baseRef.current) return;
    const flat = rasterizeShapes(baseRef.current, layerData.width, layerData.height, shapesArr);
    lastEmittedRef.current = flat;
    onChange({ ...layerData, pixels: flat });
  };

  const pushHistory = () => {
    if (!baseRef.current) return;
    history.current.push({ base: baseRef.current.slice(), shapes: shapesRef.current });
    if (history.current.length > 30) history.current.shift();
    setCanUndo(true);
  };

  const undo = () => {
    if (!layerData || !history.current.length) return;
    const entry = history.current.pop();
    setCanUndo(history.current.length > 0);
    clearShape();
    // A stroke still in progress must snapshot again after the rollback.
    strokeActive.current = false;
    baseRef.current = entry.base;
    setShapesAll(entry.shapes);
    setSelectedId(null);
    emit(entry.shapes);
  };

  const paintBrush = (cx, cy, value, size, { newStroke = false } = {}) => {
    if (!layerData || !baseRef.current) return;
    if (newStroke || !strokeActive.current) {
      pushHistory();
      strokeActive.current = true;
    }
    const base = baseRef.current.slice();
    const r = Math.max(1, size);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= layerData.width || y >= layerData.height) continue;
        base[y * layerData.width + x] = value;
      }
    }
    baseRef.current = base;
    emit();
  };

  const addShape = (shape) => {
    pushHistory();
    const next = [...shapesRef.current, shape];
    setShapesAll(next);
    setSelectedId(shape.id);
    emit(next);
  };

  const changeShape = (shape) => {
    const next = shapesRef.current.map((s) => (s.id === shape.id ? shape : s));
    setShapesAll(next);
    emit(next);
  };

  const removeSelected = () => {
    if (selectedId == null) return;
    pushHistory();
    const next = shapesRef.current.filter((s) => s.id !== selectedId);
    setShapesAll(next);
    setSelectedId(null);
    emit(next);
  };

  const activeValue = tool === 'erase' ? eraseValueFor(colorMode) : paintValueFor(colorMode);

  // Painting the semantic layer with no room selected would write id 0, which
  // is "unlabelled" — it would read as a brush that silently does nothing.
  const canPaint = colorMode !== 'semantic' || tool === 'erase' || activeRegionId > 0;

  const onPaint = (cx, cy) => {
    if (!canPaint) return;
    if (tool === 'brush' || tool === 'erase') {
      paintBrush(cx, cy, activeValue, brushSize);
    }
  };

  const endStroke = () => {
    strokeActive.current = false;
  };

  // Clicks place a new shape; it paints immediately and stays selected for
  // editing. Clicking an existing shape instead is handled by the viewer.
  const handleShapeClick = (cellX, cellY, nearStart) => {
    if (!layerData || !canPaint) return;
    if (tool === 'circle') {
      if (!shapeAnchor) {
        setSelectedId(null);
        setShapeAnchor({ cellX, cellY });
      } else {
        const r = Math.round(Math.hypot(cellX - shapeAnchor.cellX, cellY - shapeAnchor.cellY));
        if (r >= 1) {
          addShape({
            id: shapeIdRef.current++,
            kind: 'circle',
            cx: shapeAnchor.cellX,
            cy: shapeAnchor.cellY,
            r,
            value: activeValue,
          });
        }
        setShapeAnchor(null);
      }
    } else if (tool === 'rect') {
      if (!shapeAnchor) {
        setSelectedId(null);
        setShapeAnchor({ cellX, cellY });
      } else {
        addShape({
          id: shapeIdRef.current++,
          kind: 'rect',
          x0: Math.min(shapeAnchor.cellX, cellX),
          y0: Math.min(shapeAnchor.cellY, cellY),
          x1: Math.max(shapeAnchor.cellX, cellX),
          y1: Math.max(shapeAnchor.cellY, cellY),
          value: activeValue,
        });
        setShapeAnchor(null);
      }
    } else if (tool === 'freehand') {
      if (nearStart && freehandPts.length >= 3) {
        addShape({ id: shapeIdRef.current++, kind: 'poly', pts: freehandPts, value: activeValue });
        setFreehandPts([]);
      } else {
        if (!freehandPts.length) setSelectedId(null);
        setFreehandPts((p) => [...p, [cellX, cellY]]);
      }
    }
  };

  // Double-click finishes a freehand outline.
  const handleShapeClose = () => {
    if (!canPaint) return;
    const pts = freehandPts.filter(
      (p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]
    );
    if (tool === 'freehand' && pts.length >= 3) {
      addShape({ id: shapeIdRef.current++, kind: 'poly', pts, value: activeValue });
      setFreehandPts([]);
    }
  };

  const selectTool = (t) => {
    setTool(t);
    clearShape();
    setSelectedId(null);
  };

  // role="radio" means arrow keys move the selection and only the selected tool
  // is in the tab order — same contract as the sidebar's segmented controls.
  const onToolKey = (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = TOOLS.findIndex((t) => t.id === tool);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = TOOLS[(i + step + TOOLS.length) % TOOLS.length];
    selectTool(next.id);
    segRef.current?.querySelector(`[data-tool="${next.id}"]`)?.focus();
  };

  // Keyboard: Esc cancels/deselects, Delete removes the selected shape,
  // Ctrl/Cmd+Z undoes. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName || '';
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      // Buttons keep their native Enter/Space/Delete behavior, but Escape and
      // Ctrl+Z stay live so a just-clicked button doesn't deaden them.
      const onButton = tag === 'BUTTON';
      if (e.key === 'Escape') {
        clearShape();
        setSelectedId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId != null && !onButton) {
        e.preventDefault();
        removeSelected();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        // Undoing under the crop panel would dirty the buffer it requires clean.
        if (!cropMode) undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearShape, undo, selectedId, cropMode, removeSelected]);

  if (!layerData) {
    return (
      <div className="viewer-wrap viewer-wrap--empty">
        <p className="cp-empty" style={{ maxWidth: 320 }}>
          Pick a map above, then choose the layer you want to paint.
        </p>
      </div>
    );
  }

  // Crop takes over the canvas: nothing can be painted while a box is being set.
  const clickMode = cropMode
    ? 'crop'
    : tool === 'brush' || tool === 'erase'
      ? 'paint'
      : SHAPE_TOOLS.includes(tool)
        ? 'shape'
        : 'view';

  const activeRegion = (semanticRegions || []).find((r) => r.id === activeRegionId) || null;

  const shapeHint = () => {
    if (cropMode) {
      return cropBox
        ? 'Drag the selection edges to adjust. Drag elsewhere to pan.'
        : 'Select "Draw crop box", then click two opposite corners on the map.';
    }
    if (selectedId != null) {
      return 'Drag the shape to move it, or drag a handle to resize. Delete removes it; Esc deselects.';
    }
    if (colorMode === 'semantic' && !activeRegion) {
      return 'Add a room above and select it, then paint the area it covers.';
    }
    if (tool === 'circle') {
      return shapeAnchor
        ? 'Move to size the circle, then click to set the radius. (Esc to cancel)'
        : 'Click to place the circle centre, or click an existing shape to edit it.';
    }
    if (tool === 'rect') {
      return shapeAnchor
        ? 'Move to size the rectangle, then click the opposite corner. (Esc to cancel)'
        : 'Click to place the first corner, or click an existing shape to edit it.';
    }
    if (tool === 'freehand') {
      return freehandPts.length
        ? 'Click to add points; click the start dot or double-click to close & fill. (Esc to cancel)'
        : 'Click to drop the first point, or click an existing shape to edit it.';
    }
    if (colorMode === 'keepout') return 'Brush paints keep-out zones; Erase clears them back to free.';
    if (colorMode === 'speed') return 'Brush paints a slow zone at the chosen speed; Erase restores full speed.';
    if (colorMode === 'semantic') {
      return `Brush fills in ${activeRegion.name}; Erase takes the area back to unnamed.`;
    }
    if (colorMode === 'binary') {
      return 'Brush marks the areas the binary filter reacts to; Erase clears them.';
    }
    return 'Brush paints walls (occupied); Erase clears to free space.';
  };

  return (
    <>
      <div className="edit-tools">
        {/* Not `hidden`: .edit-tools__row's display:flex would defeat it. */}
        {!cropMode && (
        <div className="edit-tools__row">
          <div
            className="seg seg--inline"
            role="radiogroup"
            aria-label="Paint tool"
            ref={segRef}
            onKeyDown={onToolKey}
          >
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                className="seg__btn"
                data-tool={t.id}
                aria-checked={tool === t.id}
                tabIndex={tool === t.id ? 0 : -1}
                title={t.title}
                onClick={() => selectTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            onClick={undo}
            disabled={!canUndo}
            title="Undo last change (Ctrl/Cmd+Z)"
          >
            ↶ Undo
          </button>
          {selectedId != null && (
            <button
              type="button"
              className="btn warn"
              onClick={removeSelected}
              title="Delete the selected shape (Del)"
            >
              Delete shape
            </button>
          )}
          <label className="edit-tools__slider" title="How wide the brush and eraser paint.">
            <span>Brush size</span>
            <input
              type="range"
              min={1}
              max={20}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
            <b>{brushSize}</b>
          </label>
          {colorMode === 'speed' && (
            <label
              className="edit-tools__slider"
              title="Share of full speed the robot keeps in painted zones. "
            >
              <span>Zone speed</span>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={speedPct}
                onChange={(e) => setSpeedPct(Number(e.target.value))}
              />
              <b>{speedPct}%</b>
              <span
                aria-hidden
                className="edit-tools__swatch"
                style={{
                  background: `rgb(${paintValueFor('speed')},${paintValueFor('speed')},${paintValueFor('speed')})`,
                }}
              />
            </label>
          )}
        </div>
        )}
        <p className="cp-hint">{shapeHint()}</p>
      </div>
      <div className="viewer-wrap" onPointerUp={endStroke} onPointerLeave={endStroke}>
        <MapViewer
          grid={grid}
          backgroundGrid={backgroundGrid}
          colorMode={colorMode}
          clickMode={clickMode}
          brushSize={brushSize}
          paintValue={activeValue}
          onPaint={onPaint}
          semanticRegions={semanticRegions}
          cropBox={cropBox}
          onCropRect={onCropRect}
          cropDrawArmed={cropDrawArmed}
          onCropDrawDone={onCropDrawDone}
          cropRemoveMode={cropRemoveMode}
          previewRotationDeg={previewRotationDeg}
          shapes={shapes}
          selectedShapeId={selectedId}
          onSelectShape={setSelectedId}
          onShapeChange={changeShape}
          onShapeEditStart={pushHistory}
          showRecenter
          shapeTool={SHAPE_TOOLS.includes(tool) ? tool : null}
          shapeAnchor={shapeAnchor}
          freehandPoints={freehandPts}
          onShapeClick={handleShapeClick}
          onShapeClose={handleShapeClose}
        />
      </div>
    </>
  );
}
