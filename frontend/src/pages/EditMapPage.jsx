import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import MapLayerEditor from '../components/MapLayerEditor';
import MapShapePanel from '../components/MapShapePanel';
import SemanticRegionBar from '../components/SemanticRegionBar';

/**
 * Which saved map + which layer of it you are painting. The layer cards say what
 * each layer *is* and what it will do once navigation runs.
 */
const LAYERS = [
  {
    id: 'occupancy',
    label: 'Occupancy',
    desc: 'The walls and free space Nav2 plans around. Editing this changes the map itself.',
    has: null,
  },
  {
    id: 'keepout',
    label: 'Keepout',
    desc: 'Areas the robot must never enter. Switch on the keepout filter when you start navigation.',
    has: 'has_keepout',
  },
  {
    id: 'speed',
    label: 'Speed',
    desc: 'Areas where the robot slows down. Switch on the speed filter when you start navigation.',
    has: 'has_speed',
  },
  {
    id: 'semantic',
    label: 'Rooms',
    desc: 'Name the areas of your home — kitchen, bedroom.',
    has: null,
  },
  {
    id: 'binary',
    label: 'Binary filter',
    desc: 'Mark areas for a binary filter.',
    has: null,
  },
];

/**
 * The API stores pixels in file order (row 0 = top of the image). The editor
 * works bottom-up like the world frame, so rows are flipped on load and
 * flipped back on save. Same function both ways.
 */
function flipRows(data) {
  if (!data?.pixels) return data;
  const { width, height, pixels } = data;
  const flipped = new Array(pixels.length);
  for (let r = 0; r < height; r++) {
    const src = r * width;
    const dst = (height - 1 - r) * width;
    for (let c = 0; c < width; c++) flipped[dst + c] = pixels[src + c];
  }
  return { ...data, pixels: flipped };
}

export default function EditMapPage({ initialMapName = '', onError, onBusy }) {
  const [maps, setMaps] = useState([]);
  const [mapName, setMapName] = useState(initialMapName);
  const [layer, setLayer] = useState('occupancy');
  const [layerData, setLayerData] = useState(null);
  const [backgroundLayerData, setBackgroundLayerData] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Named rooms for the semantic layer, and which one the brush fills in.
  const [regions, setRegions] = useState([]);
  const [activeRegionId, setActiveRegionId] = useState(0);
  // Crop & rotate: a whole-map operation, so it is its own panel rather than a
  // paint tool, and it works on the saved files rather than the pixel buffer.
  const [shapePanel, setShapePanel] = useState(false);
  const [cropBox, setCropBox] = useState(null);
  // Held here, not in the panel, so the canvas can preview them live.
  const [rotateDeg, setRotateDeg] = useState(0);
  const [cropRemove, setCropRemove] = useState(false);
  const [drawArmed, setDrawArmed] = useState(false);
  // A switch the user asked for that would throw away unsaved paint. Mirrored
  // into a ref because save() has to read it back *after* its awaits, where the
  // captured state value would be stale.
  const [pendingSwitch, setPendingSwitch] = useState(null); // {kind:'map'|'layer', value}
  const pendingRef = useRef(null);
  const pickerRef = useRef(null);

  const setPending = (next) => {
    pendingRef.current = next;
    setPendingSwitch(next);
  };

  const refreshMaps = async () => {
    try {
      const res = await api('/api/maps');
      setMaps(res.maps || []);
    } catch (err) {
      onError?.(err.message);
    }
  };

  useEffect(() => {
    refreshMaps();
  }, []);

  // Room names live in their own file, so they load per map rather than per layer.
  useEffect(() => {
    if (!mapName) {
      setRegions([]);
      setActiveRegionId(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api(`/api/maps/${encodeURIComponent(mapName)}/semantic`);
        if (cancelled) return;
        const list = res.regions || [];
        setRegions(list);
        setActiveRegionId(list.length ? list[0].id : 0);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapName]);

  const selectedMap = useMemo(
    () => maps.find((m) => m.name === mapName) || null,
    [maps, mapName]
  );
  // A map copied into the maps folder by hand keeps its own file names. It is
  // listed, but nothing can be loaded from it until it is converted.
  const needsSetup = !!selectedMap?.needs_setup;
  const [settingUp, setSettingUp] = useState(false);

  const setUpMap = async () => {
    if (!mapName || settingUp) return;
    setSettingUp(true);
    onBusy?.(true);
    try {
      await api(`/api/maps/${encodeURIComponent(mapName)}/setup`, { method: 'POST' });
      await refreshMaps();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSettingUp(false);
      onBusy?.(false);
    }
  };

  // Bumped on every load so a slow response for a map/layer the user has since
  // switched away from cannot overwrite the current buffer.
  const loadSeq = useRef(0);
  // Bumped when a load lands; tells the editor to drop undo history and any
  // pending shape (they belong to the previous buffer).
  const [loadVersion, setLoadVersion] = useState(0);

  const loadLayer = async () => {
    const seq = ++loadSeq.current;
    if (!mapName || needsSetup) {
      setLayerData(null);
      setBackgroundLayerData(null);
      setLoadVersion((v) => v + 1);
      onBusy?.(false);
      return;
    }
    onBusy?.(true);
    // Empty the buffer while fetching: painting or saving the previous layer's
    // pixels against the new layer's endpoint must be impossible.
    setLayerData(null);
    setBackgroundLayerData(null);
    try {
      const activeLayerPath = `/api/maps/${encodeURIComponent(mapName)}/layer/${layer}`;
      if (layer === 'occupancy') {
        const data = await api(activeLayerPath);
        if (seq !== loadSeq.current) return;
        setLayerData(flipRows(data));
        setBackgroundLayerData(null);
      } else {
        const [occupancyData, activeData] = await Promise.all([
          api(`/api/maps/${encodeURIComponent(mapName)}/layer/occupancy`),
          api(activeLayerPath),
        ]);
        if (seq !== loadSeq.current) return;
        setLayerData(flipRows(activeData));
        setBackgroundLayerData(flipRows(occupancyData));
      }
      setDirty(false);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      onError?.(err.message);
      setLayerData(null);
      setBackgroundLayerData(null);
    } finally {
      if (seq === loadSeq.current) {
        onBusy?.(false);
        setLoadVersion((v) => v + 1);
      }
    }
  };

  useEffect(() => {
    loadLayer();
  }, [mapName, layer, needsSetup]);

  const activeLayer = LAYERS.find((l) => l.id === layer) || LAYERS[0];

  const applySwitch = (kind, value) => {
    if (kind === 'map') setMapName(value);
    else setLayer(value);
    // The load effect clears dirty when it lands, but not when the target is the
    // empty "pick a map" option — that path never loads anything.
    setDirty(false);
    setPending(null);
  };

  // Loading a different map/layer replaces the pixel buffer, so unsaved paint is
  // gone for good — ask before doing it.
  const requestSwitch = (kind, value) => {
    if (saving) return;
    if (kind === 'map' ? value === mapName : value === layer) return;
    if (dirty) setPending({ kind, value });
    else applySwitch(kind, value);
  };

  // Mirrors layerData so save() can tell whether edits landed mid-flight.
  const layerDataRef = useRef(null);
  useEffect(() => {
    layerDataRef.current = layerData;
  }, [layerData]);

  const save = async () => {
    if (!layerData || !mapName || saving) return;
    setSaving(true);
    onBusy?.(true);
    try {
      await api(`/api/maps/${encodeURIComponent(mapName)}/layer/${layer}`, {
        method: 'POST',
        body: JSON.stringify({
          width: layerData.width,
          height: layerData.height,
          pixels: flipRows(layerData).pixels,
          resolution: layerData.resolution,
          origin: layerData.origin,
        }),
      });
      // Edits made while the request was in flight are not on disk — those
      // must stay marked unsaved.
      if (layerDataRef.current === layerData) setDirty(false);
      await refreshMaps();
      // Read the ref, not the captured state: this runs after two awaits.
      const next = pendingRef.current;
      if (next) applySwitch(next.kind, next.value);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
      onBusy?.(false);
    }
  };

  const saveRegions = async (next) => {
    const previous = regions;
    setRegions(next); // optimistic: the strip is a direct-manipulation control
    try {
      const res = await api(`/api/maps/${encodeURIComponent(mapName)}/semantic`, {
        method: 'PUT',
        body: JSON.stringify({ regions: next }),
      });
      setRegions(res.regions || next);
      await refreshMaps();
    } catch (err) {
      setRegions(previous);
      onError?.(err.message);
    }
  };

  // Deleting a room has to clear its paint too, or the pixels keep an id that
  // nothing names and the area shows up as an unlabelled hole.
  const deleteRegion = async (id) => {
    if (layer === 'semantic' && layerData) {
      const pixels = layerData.pixels.map((p) => (p === id ? 0 : p));
      setLayerData({ ...layerData, pixels });
      setDirty(true);
    }
    const next = regions.filter((r) => r.id !== id);
    if (activeRegionId === id) setActiveRegionId(next.length ? next[0].id : 0);
    await saveRegions(next);
  };

  // Crop/rotate reshapes the map itself, so it is started from the occupancy
  // layer only — the masks and locations are carried along by the backend
  // rather than being reshaped one at a time. It also rewrites every layer on
  // disk, so unsaved paint in the buffer would be written back over the
  // transformed files by the next save.
  const resetShapeState = () => {
    setCropBox(null);
    setRotateDeg(0);
    setDrawArmed(false);
    setCropRemove(false);
  };

  const openShapePanel = () => {
    if (layer !== 'occupancy') return;
    if (dirty) {
      onError?.('Save or discard your changes before cropping or rotating.');
      return;
    }
    resetShapeState();
    setShapePanel(true);
  };

  // Switching layer or map while the panel is open would leave a crop box
  // floating over content it was not drawn against.
  useEffect(() => {
    if (layer !== 'occupancy') {
      setShapePanel(false);
      resetShapeState();
    }
  }, [layer]);
  useEffect(() => {
    setShapePanel(false);
    resetShapeState();
  }, [mapName]);

  const closeShapePanel = () => {
    setShapePanel(false);
    resetShapeState();
  };

  const afterTransform = async () => {
    resetShapeState();
    await refreshMaps();
    await loadLayer();
  };

  // role="radio" means arrow keys move the selection and only the selected card
  // is in the tab order.
  const onPickerKey = (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = LAYERS.findIndex((l) => l.id === layer);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = LAYERS[(i + step + LAYERS.length) % LAYERS.length];
    requestSwitch('layer', next.id);
    // If the switch was held back for confirmation the selection did not move,
    // so focus must not move either.
    if (!dirty) pickerRef.current?.querySelector(`[data-layer="${next.id}"]`)?.focus();
  };

  const layerBadge = (l) => {
    if (!mapName) return null;
    if (l.id === 'semantic') {
      const n = selectedMap?.semantic_regions || 0;
      return (
        <span className="layer-card__badge" data-exists={n > 0}>
          {n > 0 ? `${n} named` : 'Empty'}
        </span>
      );
    }
    if (!l.has && l.id !== 'binary') return null;
    const painted = !!selectedMap?.[`${l.id}_painted`];
    return (
      <span className="layer-card__badge" data-exists={painted}>
        {painted ? 'Painted' : 'Empty'}
      </span>
    );
  };

  return (
    <div className="edit-page">
      <header className="edit-bar">
        <div className="edit-bar__row">
          <h2 className="edit-bar__title">Edit map</h2>
          <label className="edit-bar__field">
            <span>Map</span>
            <select
              value={mapName}
              disabled={saving}
              onChange={(e) => requestSwitch('map', e.target.value)}
            >
              <option value="">— pick a map —</option>
              {maps.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.needs_setup ? `${m.name} — needs setup` : m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="edit-bar__save">
            <button
              type="button"
              className="btn"
              disabled={!mapName || saving || needsSetup || shapePanel || layer !== 'occupancy'}
              onClick={openShapePanel}
              title={
                layer === 'occupancy'
                  ? 'Trim the empty border off the map or turn it straight.'
                  : 'Switch to the Occupancy layer to crop or rotate. '
              }
            >
              Crop &amp; rotate
            </button>
            {dirty && <span className="edit-bar__dirty">Unsaved changes</span>}
            <button
              type="button"
              className="btn primary"
              disabled={!dirty || saving}
              onClick={save}
              title={`Write the ${activeLayer.label.toLowerCase()} layer back to the map folder.`}
            >
              {saving ? (
                <>
                  <span className="spinner" /> Saving…
                </>
              ) : (
                `Save ${activeLayer.label.toLowerCase()} layer`
              )}
            </button>
          </div>
        </div>

        {needsSetup && (
          <div className="edit-setup" role="status">
            <span>
              <strong>{mapName}</strong> is not in the layout this app uses — its files
              are named something other than <code>map.pgm</code> / <code>map.yaml</code>,
              so there is nothing to draw on yet. Setting it up copies it into the right
              layout with empty keepout, speed and room layers. Your original files stay
              where they are.
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={settingUp}
              onClick={setUpMap}
            >
              {settingUp ? 'Setting up…' : 'Set up this map'}
            </button>
          </div>
        )}

        <div
          className="layer-picker"
          role="radiogroup"
          aria-label="Layer to edit"
          ref={pickerRef}
          onKeyDown={onPickerKey}
        >
          {LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              data-layer={l.id}
              aria-checked={layer === l.id}
              tabIndex={layer === l.id ? 0 : -1}
              className="layer-card"
              disabled={!mapName || saving || needsSetup}
              onClick={() => requestSwitch('layer', l.id)}
            >
              <span className="layer-card__top">
                <span className={`layer-card__swatch layer-card__swatch--${l.id}`} aria-hidden="true" />
                <span className="layer-card__name">{l.label}</span>
                {layerBadge(l)}
              </span>
              <span className="layer-card__desc">{l.desc}</span>
            </button>
          ))}
        </div>

        {pendingSwitch && (
          <div className="edit-bar__confirm" role="group" aria-label="Unsaved changes">
            <span>
              You have unsaved changes to the <strong>{activeLayer.label.toLowerCase()}</strong> layer.
            </span>
            <div className="edit-bar__confirm-actions">
              <button
                type="button"
                className="btn quiet"
                disabled={saving}
                onClick={() => setPending(null)}
              >
                Keep editing
              </button>
              <button type="button" className="btn" disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save first'}
              </button>
              <button
                type="button"
                className="btn warn"
                disabled={saving}
                onClick={() => applySwitch(pendingSwitch.kind, pendingSwitch.value)}
              >
                Discard and switch
              </button>
            </div>
          </div>
        )}

        {shapePanel && (
          <MapShapePanel
            mapName={mapName}
            layerData={layerData}
            cropBox={cropBox}
            onCropBox={setCropBox}
            removeMode={cropRemove}
            onRemoveMode={setCropRemove}
            drawArmed={drawArmed}
            onDrawArmed={setDrawArmed}
            rotateDeg={rotateDeg}
            onRotate={setRotateDeg}
            onDone={afterTransform}
            onClose={closeShapePanel}
            onError={onError}
            onBusy={onBusy}
          />
        )}

        {!shapePanel && layer === 'semantic' && mapName && (
          <SemanticRegionBar
            regions={regions}
            activeRegionId={activeRegionId}
            onSelect={setActiveRegionId}
            onChange={saveRegions}
            onDelete={deleteRegion}
          />
        )}
      </header>

      <div className="edit-page__body">
        <MapLayerEditor
          layerData={layerData}
          backgroundLayerData={backgroundLayerData}
          resetVersion={loadVersion}
          colorMode={layer}
          semanticRegions={regions}
          activeRegionId={activeRegionId}
          cropMode={shapePanel}
          cropBox={cropBox}
          onCropRect={setCropBox}
          cropDrawArmed={drawArmed}
          onCropDrawDone={() => setDrawArmed(false)}
          cropRemoveMode={cropRemove}
          previewRotationDeg={shapePanel ? rotateDeg : 0}
          onChange={(next) => {
            setLayerData(next);
            setDirty(true);
          }}
        />
      </div>
    </div>
  );
}
