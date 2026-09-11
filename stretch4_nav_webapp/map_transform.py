"""Crop and rotate a saved map — every layer and every location together.

A map is not one file. Cropping map.pgm on its own leaves keepout.pgm, speed.pgm
and semantic.pgm the wrong size and every saved location pointing at the wrong
place. So the whole folder is transformed in one call, or not at all.

The geometry, in one place so it can be checked:

  A cell (col, j) — j counted from the *bottom* row, the way map_server counts —
  sits at world (ox + res*col, oy + res*j).

  CROP by a box: the remaining cells keep their world positions, so only the
  origin moves. Locations are untouched.

  ROTATE by θ: Nav2's costmaps assume an axis-aligned map, so we do not write a
  yaw into the yaml origin. Instead the *world frame turns with the map*: a
  feature at world q ends up at c + R(q - c), where c is the world point at the
  centre of the old image and R is a CCW rotation by θ. Locations get that same
  transform (their heading gains θ), so a location painted on the kitchen door
  is still on the kitchen door afterwards.

"""

from __future__ import annotations

import json
import logging
import math
import shutil
from pathlib import Path
from typing import Any, Optional

import yaml
from PIL import Image

from stretch4_nav_webapp.maps_api import (
    DEFAULT_OCCUPIED_THRESH,
    TRINARY_FREE_THRESH,
    trinary_pixel_bounds,
)
from stretch4_nav_webapp.paths import LAYER_FILES, backup_dir, layer_paths, locations_path, map_dir

logger = logging.getLogger(__name__)

# What a layer's empty space is
LAYER_FILL = {
    "speed": 255,  # no speed restriction
    "semantic": 0,  # unlabelled
    "binary": 255,  # state left alone
}


def _layer_fill(layer: str, meta: dict) -> int:
    """Empty-canvas pixel for a layer, honouring the layer's own YAML."""
    if layer in ("occupancy", "keepout"):
        free = float(meta.get("free_thresh", TRINARY_FREE_THRESH))
        occupied = float(meta.get("occupied_thresh", DEFAULT_OCCUPIED_THRESH))
        return trinary_pixel_bounds(free, occupied)[1]
    return LAYER_FILL.get(layer, 0)

def _read_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _write_yaml(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)


def _existing_layers(maps_root: Path, name: str) -> list[str]:
    out = []
    for layer in LAYER_FILES:
        pgm, yml = layer_paths(maps_root, name, layer)
        if pgm.is_file() and yml.is_file():
            out.append(layer)
    return out


def explored_bounds(maps_root: Path, name: str, margin: int = 10) -> dict[str, int]:
    """Tightest box around everything the laser actually saw, plus a margin.

    Returned in image pixel coordinates (left/top with row 0 at the top), which
    is what the editor's canvas and PIL both use.
    """
    pgm, yml = layer_paths(maps_root, name, "occupancy")
    img = Image.open(pgm).convert("L")
    width, height = img.size

    meta = _read_yaml(yml) if yml.is_file() else {}
    free = float(meta.get("free_thresh", TRINARY_FREE_THRESH))
    occupied = float(meta.get("occupied_thresh", DEFAULT_OCCUPIED_THRESH))
    lethal_below, unknown_pixel = trinary_pixel_bounds(free, occupied)

    known = img.point(
        lambda v: 0 if lethal_below <= v <= unknown_pixel else 255, mode="L"
    )
    box = known.getbbox()
    if box is None:
        # Nothing was ever seen — refuse to crop to an empty image.
        return {"left": 0, "top": 0, "width": width, "height": height}

    left, top, right, bottom = box
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(width, right + margin)
    bottom = min(height, bottom + margin)
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def _backup(maps_root: Path, name: str) -> None:
    """Stash the current map folder so one crop/rotate can be undone."""
    src = map_dir(maps_root, name)
    dest = backup_dir(maps_root, name)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for child in src.iterdir():
        if child.is_file():
            shutil.copy2(child, dest / child.name)


def restore_backup(maps_root: Path, name: str) -> dict:
    """Put back whatever the last crop/rotate replaced."""
    src = backup_dir(maps_root, name)
    if not src.is_dir() or not (src / "map.pgm").is_file():
        raise FileNotFoundError("No pre-transform copy of this map to restore")
    dest = map_dir(maps_root, name)
    for child in src.iterdir():
        if child.is_file():
            shutil.copy2(child, dest / child.name)
    shutil.rmtree(src)
    return {"ok": True, "name": name, "restored": True}


def has_backup(maps_root: Path, name: str) -> bool:
    return (backup_dir(maps_root, name) / "map.pgm").is_file()


def _rotate_point(x: float, y: float, cx: float, cy: float, theta: float) -> tuple[float, float]:
    """Rotate (x, y) CCW by theta radians about (cx, cy)."""
    dx = x - cx
    dy = y - cy
    return (
        cx + dx * math.cos(theta) - dy * math.sin(theta),
        cy + dx * math.sin(theta) + dy * math.cos(theta),
    )


def transform_map(
    maps_root: Path,
    name: str,
    *,
    crop: Optional[dict] = None,
    crop_mode: str = "keep",
    rotate_deg: float = 0.0,
) -> dict[str, Any]:
    """Crop and/or rotate every layer of a map, keeping locations on target.
    """
    folder = map_dir(maps_root, name)
    occ_pgm, occ_yaml = layer_paths(maps_root, name, "occupancy")
    if not occ_pgm.is_file() or not occ_yaml.is_file():
        raise FileNotFoundError(f"Occupancy map missing for {name}")

    if crop_mode not in ("keep", "remove"):
        raise ValueError(f"Unknown crop_mode: {crop_mode}")
    rotate_deg = float(rotate_deg) % 360.0
    if crop is None and rotate_deg == 0.0:
        raise ValueError("Nothing to do: give a crop box, an angle, or both")

    occ_meta = _read_yaml(occ_yaml)
    res = float(occ_meta.get("resolution", 0.05))
    origin = list(occ_meta.get("origin", [0.0, 0.0, 0.0]))
    ox, oy = float(origin[0]), float(origin[1])
    oyaw = float(origin[2]) if len(origin) > 2 else 0.0

    base_w, base_h = Image.open(occ_pgm).size

    if crop is not None:
        left = int(crop.get("left", 0))
        top = int(crop.get("top", 0))
        cw = int(crop.get("width", base_w))
        ch = int(crop.get("height", base_h))
        if cw <= 0 or ch <= 0:
            raise ValueError("Crop width and height must be positive")
        if left < 0 or top < 0 or left + cw > base_w or top + ch > base_h:
            raise ValueError(
                f"Crop box {left},{top} {cw}x{ch} falls outside the {base_w}x{base_h} map"
            )
        if crop_mode == "keep":
            # Kept cells stay at their world positions; only the origin moves.
            # It names the bottom-left corner, hence rows below the box.
            ox += left * res
            oy += (base_h - top - ch) * res
    else:
        left = top = 0
        cw, ch = base_w, base_h

    # Canvas size going into the rotation step.
    kept_w, kept_h = (cw, ch) if crop is not None and crop_mode == "keep" else (base_w, base_h)
    # Origin before the rotation shifts it — needed for the removed-box check.
    pre_ox, pre_oy = ox, oy

    layers = _existing_layers(maps_root, name)
    _backup(maps_root, name)

    theta = math.radians(rotate_deg)
    rotated: dict[str, Image.Image] = {}
    for layer in layers:
        pgm, yml = layer_paths(maps_root, name, layer)
        fill = _layer_fill(layer, _read_yaml(yml) if yml.is_file() else {})
        img = Image.open(pgm)
        # The semantic layer is indexed colour: converting it to "L" would map
        # every pixel through its palette and destroy the room ids.
        if not (layer == "semantic" and img.mode == "P"):
            img = img.convert("L")
        if img.size != (base_w, base_h):
            # A sidecar that drifted out of sync would silently misregister.
            logger.warning(
                "%s layer of map %s is %s, expected %s — rebuilding it blank",
                layer, name, img.size, (base_w, base_h),
            )
            blank = Image.new(img.mode, (base_w, base_h), color=fill)
            if img.mode == "P":
                blank.putpalette(img.getpalette() or [])
            img = blank
        if crop is not None:
            if crop_mode == "keep":
                img = img.crop((left, top, left + cw, top + ch))
            else:
                img.paste(fill, (left, top, left + cw, top + ch))
        if rotate_deg:
            img = img.rotate(
                rotate_deg,
                resample=Image.NEAREST,
                expand=True,
                fillcolor=fill,
            )
        rotated[layer] = img

    new_w, new_h = rotated["occupancy"].size

    if rotate_deg:
        # Rotation is about the image centre; the origin shift keeps that
        # world point at the centre of the grown canvas.
        cx = ox + (kept_w / 2.0) * res
        cy = oy + (kept_h / 2.0) * res
        ox = ox + (kept_w / 2.0 - new_w / 2.0) * res
        oy = oy + (kept_h / 2.0 - new_h / 2.0) * res
    else:
        cx = cy = 0.0

    for layer, img in rotated.items():
        pgm, yml = layer_paths(maps_root, name, layer)
        img.save(pgm)
        meta = _read_yaml(yml) if yml.is_file() else {}
        meta["image"] = pgm.name
        meta["resolution"] = res
        meta["origin"] = [ox, oy, oyaw]
        _write_yaml(yml, meta)

    moved_locations = 0
    off_map = 0
    in_removed = 0
    loc_path = locations_path(maps_root, name)
    if loc_path.is_file():
        try:
            locs = json.loads(loc_path.read_text(encoding="utf-8") or "[]")
        except json.JSONDecodeError:
            locs = []
        if isinstance(locs, list):
            for loc in locs:
                if crop is not None and crop_mode == "remove":
                    col = math.floor((float(loc.get("x", 0.0)) - pre_ox) / res)
                    img_row = base_h - 1 - math.floor((float(loc.get("y", 0.0)) - pre_oy) / res)
                    if left <= col < left + cw and top <= img_row < top + ch:
                        in_removed += 1
                if rotate_deg:
                    lx, ly = _rotate_point(
                        float(loc.get("x", 0.0)), float(loc.get("y", 0.0)), cx, cy, theta
                    )
                    loc["x"] = lx
                    loc["y"] = ly
                    loc["yaw"] = float(loc.get("yaw", 0.0)) + theta
                    moved_locations += 1
                col = (float(loc.get("x", 0.0)) - ox) / res
                row = (float(loc.get("y", 0.0)) - oy) / res
                if not (0 <= col < new_w and 0 <= row < new_h):
                    off_map += 1
            loc_path.write_text(json.dumps(locs, indent=2) + "\n", encoding="utf-8")

    return {
        "ok": True,
        "name": name,
        "width": new_w,
        "height": new_h,
        "origin": [ox, oy, oyaw],
        "resolution": res,
        "layers": layers,
        "rotate_deg": rotate_deg,
        "crop": {"left": left, "top": top, "width": cw, "height": ch} if crop else None,
        "crop_mode": crop_mode if crop else None,
        "locations_moved": moved_locations,
        "locations_off_map": off_map,
        "locations_in_removed": in_removed,
        "can_undo": True,
        "path": str(folder),
    }
