import { useState } from 'react';

/**
 * The named rooms of the semantic layer: pick one to paint with, add, rename,
 * recolour, delete.
 *
 * A region's id is the pixel value written into semantic.pgm, so ids are never
 * reused — deleting "Kitchen" and adding "Study" gives the study a fresh id
 * rather than inheriting every pixel the kitchen used to own.
 */
const PALETTE = [
  '#e6a23c', '#3ecf8e', '#3d9cf0', '#e85d5d',
  '#b07cf0', '#4fd0d8', '#f0d24f', '#f08bb4',
];

export default function SemanticRegionBar({
  regions,
  activeRegionId,
  onSelect,
  onChange,
  onDelete,
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(null); // region id
  const [renameText, setRenameText] = useState('');

  // One past the highest id ever handed out, not the lowest free one: a deleted
  // room's pixels are only cleared when the layer is saved, and reusing its id
  // would adopt whatever paint was left behind.
  const nextId = () => {
    const highest = regions.reduce((m, r) => Math.max(m, r.id), 0);
    if (highest < 255) return highest + 1;
    const used = new Set(regions.map((r) => r.id));
    for (let i = 1; i <= 255; i++) if (!used.has(i)) return i;
    return 0;
  };

  const commitAdd = () => {
    const name = draft.trim();
    setAdding(false);
    setDraft('');
    if (!name) return;
    const id = nextId();
    if (!id) return;
    const region = { id, name, color: PALETTE[regions.length % PALETTE.length] };
    onChange([...regions, region]);
    onSelect(id);
  };

  const commitRename = (id) => {
    const name = renameText.trim();
    setRenaming(null);
    if (!name) return;
    onChange(regions.map((r) => (r.id === id ? { ...r, name } : r)));
  };

  const cycleColor = (region) => {
    const i = PALETTE.indexOf(region.color);
    const color = PALETTE[(i + 1 + PALETTE.length) % PALETTE.length];
    onChange(regions.map((r) => (r.id === region.id ? { ...r, color } : r)));
  };

  return (
    <div className="rooms" role="group" aria-label="Rooms">
      <span className="rooms__label">Rooms</span>

      {regions.map((region) =>
        renaming === region.id ? (
          <input
            key={region.id}
            className="rooms__input"
            autoFocus
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={() => commitRename(region.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(region.id);
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <span
            key={region.id}
            className="rooms__chip"
            data-active={region.id === activeRegionId}
          >
            <button
              type="button"
              className="rooms__swatch"
              style={{ background: region.color }}
              title="Change this room's colour"
              onClick={() => cycleColor(region)}
              aria-label={`Change colour of ${region.name}`}
            />
            <button
              type="button"
              className="rooms__name"
              aria-pressed={region.id === activeRegionId}
              title={`Paint ${region.name}. Double-click to rename.`}
              onClick={() => onSelect(region.id)}
              onDoubleClick={() => {
                setRenameText(region.name);
                setRenaming(region.id);
              }}
            >
              {region.name}
            </button>
            <button
              type="button"
              className="rooms__x"
              title={`Delete ${region.name}. Its paint is cleared too — save the layer to keep that.`}
              onClick={() => onDelete(region.id)}
              aria-label={`Delete ${region.name}`}
            >
              ×
            </button>
          </span>
        )
      )}

      {adding ? (
        <input
          className="rooms__input"
          autoFocus
          placeholder="Kitchen"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitAdd}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAdd();
            if (e.key === 'Escape') {
              setAdding(false);
              setDraft('');
            }
          }}
        />
      ) : (
        <button type="button" className="btn sm" onClick={() => setAdding(true)}>
          + Add room
        </button>
      )}

      <span className="rooms__hint">
        {regions.length
          ? 'Pick a room, then paint the area it covers. Deleting a room also clears its paint.'
          : 'Add a room name, then paint the area it covers.'}
      </span>
    </div>
  );
}
