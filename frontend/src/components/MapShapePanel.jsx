import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Crop & rotate. Works on the saved files, all layers at once; saved locations
 * move with the map. The backend keeps one pre-transform copy for Undo.
 */
export default function MapShapePanel({
  mapName,
  layerData,
  cropBox,
  onCropBox,
  removeMode,
  onRemoveMode,
  drawArmed,
  onDrawArmed,
  rotateDeg,
  onRotate,
  onDone,
  onClose,
  onError,
  onBusy,
}) {
  const [canUndo, setCanUndo] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(null);

  const refreshInfo = async () => {
    if (!mapName) return;
    try {
      const res = await api(`/api/maps/${encodeURIComponent(mapName)}/transform`);
      setCanUndo(!!res.can_undo);
    } catch (err) {
      onError?.(err.message);
    }
  };

  useEffect(() => {
    refreshInfo();
  }, [mapName]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !working) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onClose]);

  const full = layerData
    ? { left: 0, top: 0, width: layerData.width, height: layerData.height }
    : null;
  // A full-size box in keep mode changes nothing.
  const cropDoesSomething =
    cropBox && (removeMode || !full || cropBox.width !== full.width || cropBox.height !== full.height);

  const bumpRotation = (delta) => onRotate((((rotateDeg + delta) % 360) + 360) % 360);

  // Size after rotation, matching PIL rotate(expand=True).
  const rotatedSize = (() => {
    const base = !removeMode && cropDoesSomething ? cropBox : full;
    if (!base || !rotateDeg) return null;
    const t = (rotateDeg * Math.PI) / 180;
    const c = Math.abs(Math.cos(t));
    const s = Math.abs(Math.sin(t));
    return `${Math.ceil(base.width * c + base.height * s)} × ${Math.ceil(base.width * s + base.height * c)}`;
  })();

  const cropStatus = () => {
    if (drawArmed) return 'Click two opposite corners on the map.';
    if (!cropBox) return 'No selection.';
    const size = `${cropBox.width} × ${cropBox.height}`;
    return removeMode
      ? `Selection: ${size} cells, cleared on Apply. Drag the edges to adjust.`
      : `Selection: ${size} cells, kept on Apply. Drag the edges to adjust.`;
  };

  const apply = async () => {
    if (working) return;
    if (!cropDoesSomething && !rotateDeg) {
      onError?.('Draw a crop box or set an angle first.');
      return;
    }
    setWorking(true);
    onBusy?.(true);
    try {
      const res = await api(`/api/maps/${encodeURIComponent(mapName)}/transform`, {
        method: 'POST',
        body: JSON.stringify({
          crop: cropDoesSomething ? cropBox : null,
          crop_mode: removeMode ? 'remove' : 'keep',
          rotate_deg: rotateDeg,
        }),
      });
      setResult(res);
      onRotate(0);
      await onDone?.();
      await refreshInfo();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setWorking(false);
      onBusy?.(false);
    }
  };

  const undo = async () => {
    if (working) return;
    setWorking(true);
    onBusy?.(true);
    try {
      await api(`/api/maps/${encodeURIComponent(mapName)}/transform/undo`, { method: 'POST' });
      setResult(null);
      await onDone?.();
      await refreshInfo();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setWorking(false);
      onBusy?.(false);
    }
  };

  const resultText = () => {
    if (!result) return null;
    const parts = [];
    if (result.crop_mode === 'remove') parts.push('Applied. The selected area was cleared.');
    else parts.push(`Applied. Map size: ${result.width} × ${result.height} cells.`);
    if (result.locations_moved) parts.push(`${result.locations_moved} saved location(s) updated.`);
    if (result.locations_off_map) {
      parts.push(`${result.locations_off_map} location(s) fall outside the new map — review them.`);
    }
    if (result.locations_in_removed) {
      parts.push(`${result.locations_in_removed} location(s) are inside the cleared area — review them.`);
    }
    return parts.join(' ');
  };

  return (
    <div className="shape-panel" role="group" aria-label="Crop and rotate">
      <div className="shape-panel__row">
        <strong className="shape-panel__title">Crop &amp; rotate</strong>
        <span className="shape-panel__note">
          Applies to all layers together. Saved locations are updated to match.
        </span>
        <button
          type="button"
          className="btn sm"
          onClick={onClose}
          disabled={working}
          title="Close crop & rotate and return to editing tools (Esc)"
        >
          ✕ Close
        </button>
      </div>

      <div className="shape-panel__row">
        <span className="shape-panel__label">Crop</span>
        <div className="seg seg--inline" role="radiogroup" aria-label="What the box means">
          <button
            type="button"
            role="radio"
            className="seg__btn"
            aria-checked={!removeMode}
            disabled={working}
            onClick={() => onRemoveMode(false)}
            title="Keep only what is inside the box; the rest is cut off."
          >
            Keep inside
          </button>
          <button
            type="button"
            role="radio"
            className="seg__btn"
            aria-checked={removeMode}
            disabled={working}
            onClick={() => onRemoveMode(true)}
            title="Clear what is inside the box; the map keeps its size."
          >
            Remove inside
          </button>
        </div>
        <button
          type="button"
          className={drawArmed ? 'btn sm selected' : 'btn sm'}
          aria-pressed={drawArmed}
          disabled={working}
          onClick={() => onDrawArmed(!drawArmed)}
        >
          {drawArmed ? 'Placing box…' : cropBox ? 'Draw a new box' : 'Draw crop box'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={!cropBox || working}
          onClick={() => onCropBox(null)}
        >
          Clear box
        </button>
        <span className="shape-panel__value">{cropStatus()}</span>
      </div>

      <div className="shape-panel__row">
        <span className="shape-panel__label">Rotate</span>
        {[-90, -5, -1, 1, 5, 90].map((d) => (
          <button
            key={d}
            type="button"
            className="btn sm"
            disabled={working}
            onClick={() => bumpRotation(d)}
            title={`Turn the map ${Math.abs(d)}° ${d > 0 ? 'counter-clockwise' : 'clockwise'}`}
          >
            {d > 0 ? `+${d}°` : `${d}°`}
          </button>
        ))}
        <input
          type="range"
          className="shape-panel__slider"
          value={rotateDeg}
          min={0}
          max={359}
          step={1}
          disabled={working}
          onChange={(e) => onRotate(Number(e.target.value) || 0)}
          aria-label="Rotation in degrees"
        />
        <b className="shape-panel__angle">{rotateDeg}°</b>
        <button
          type="button"
          className="btn sm"
          disabled={working || !rotateDeg}
          onClick={() => onRotate(0)}
        >
          Reset
        </button>
      </div>

      <p className="cp-hint shape-panel__preview-note">
        {rotateDeg
          ? `Previewing a ${rotateDeg}° rotation${rotatedSize ? ` — new size ${rotatedSize} cells` : ''}.`
          : 'Adjustments preview on the map. Nothing is saved until you select Apply.'}
      </p>

      {result && (
        <div className="shape-panel__row">
          <p className="shape-panel__done" style={{ margin: 0, flex: 1 }}>{resultText()}</p>
          <button
            type="button"
            className="btn sm primary"
            onClick={onClose}
            title="Done with crop & rotate — return to editing tools"
          >
            Done
          </button>
        </div>
      )}

      <div className="shape-panel__row">
        <button
          type="button"
          className="btn primary"
          disabled={working || (!cropDoesSomething && !rotateDeg)}
          onClick={apply}
        >
          {working ? (
            <>
              <span className="spinner" /> Working…
            </>
          ) : (
            'Apply to all layers'
          )}
        </button>
        <button type="button" className="btn warn" disabled={!canUndo || working} onClick={undo}>
          Undo last apply
        </button>
        <button
          type="button"
          className="btn"
          disabled={working}
          onClick={onClose}
          title="Exit crop & rotate mode"
        >
          {result ? 'Done (Exit)' : cropDoesSomething || rotateDeg ? 'Cancel & Exit' : 'Exit crop & rotate'}
        </button>
        <span className="shape-panel__value">
          {canUndo ? 'Undo restores the version before the last Apply.' : ''}
        </span>
      </div>
    </div>
  );
}
