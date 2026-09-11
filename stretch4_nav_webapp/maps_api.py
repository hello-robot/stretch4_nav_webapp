"""Map folder layout, PGM load/save, and saving the live /map to disk."""

from __future__ import annotations

import json
import logging
import math
import shutil
from pathlib import Path
from typing import Any, Optional

import yaml
from PIL import Image

from stretch4_nav_webapp.paths import (
    LAYER_FILES,
    layer_paths,
    locations_path,
    map_dir,
    semantic_json_path,
)

logger = logging.getLogger(__name__)

OCC_FREE = 254
KEEPOUT_LETHAL = 0

# nav2 map_saver's trinary YAML conventions, used only as fallbacks when a
# map's YAML doesn't carry the keys. 
TRINARY_FREE_THRESH = 0.196
DEFAULT_OCCUPIED_THRESH = 0.65


def trinary_pixel_bounds(free_thresh: float, occupied_thresh: float) -> tuple[int, int]:
    """(lethal_below, unknown_pixel) for a trinary mask, negate=0 (as everywhere here).

    """
    lethal_below = math.ceil(255 * (1.0 - occupied_thresh))
    unknown_pixel = math.floor(255 * (1.0 - free_thresh))
    if unknown_pixel < lethal_below:
        # No integer pixel can load as unknown 
        raise ValueError(
            f"invalid map YAML thresholds: occupied_thresh ({occupied_thresh}) must be "
            f"greater than free_thresh ({free_thresh}) with room for an unknown "
            "pixel between them"
        )
    return lethal_below, unknown_pixel

# Speed filter: higher pixel → higher speed.
SPEED_DEFAULT = 255  # white base = full speed / no restriction

#13 lands on a 5% limit, the minimum slowdown. for no motion keepout zone should be used.
SPEED_MIN = 13

# Semantic layer: 0 = unlabelled, 1..255 = region id (see semantic.json).
SEMANTIC_NONE = 0
# Palette entry for unlabelled space
SEMANTIC_NONE_COLOR = (255, 255, 255)
SEMANTIC_FALLBACK_COLOR = (61, 156, 240)


def _hex_to_rgb(value: str, fallback: tuple = SEMANTIC_FALLBACK_COLOR) -> tuple:
    text = str(value or "").lstrip("#")
    if len(text) != 6:
        return fallback
    try:
        return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return fallback


def _semantic_palette(regions: list[dict]) -> list[int]:
    """Flat 768-entry palette: index = region id, colour = that room's colour."""
    table = [0] * 768
    table[0:3] = list(SEMANTIC_NONE_COLOR)
    for region in regions:
        rid = int(region.get("id", 0))
        if 1 <= rid <= 255:
            table[rid * 3 : rid * 3 + 3] = list(_hex_to_rgb(region.get("color")))
    return table


def _write_semantic_image(
    path: Path, size: tuple[int, int], pixels: list[int], regions: list[dict]
) -> None:
    img = Image.new("P", size)
    img.putpalette(_semantic_palette(regions))
    img.putdata([max(0, min(255, int(p))) for p in pixels])
    img.save(path)


def _read_semantic_indices(path: Path) -> Image.Image:
    """Open the semantic layer without losing the ids.

    ``convert("L")`` on an indexed image maps every pixel *through* the palette
    and returns brightness, not the id — the room numbering would be destroyed.
    """
    img = Image.open(path)
    return img if img.mode == "P" else img.convert("L")

BINARY_OFF = 153
BINARY_OFF = 255


def ensure_maps_root(maps_root: Path) -> None:
    maps_root.mkdir(parents=True, exist_ok=True)


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)


def _read_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def blank_mask_like(reference_pgm: Path, fill: int) -> Image.Image:
    img = Image.open(reference_pgm)
    if img.mode != "L":
        img = img.convert("L")
    return Image.new("L", img.size, color=fill)


def create_sidecar_layers(maps_root: Path, name: str, meta: Optional[dict] = None) -> None:
    """Create keepout/speed masks + locations.json from occupancy map."""
    occ_pgm, occ_yaml = layer_paths(maps_root, name, "occupancy")
    if not occ_pgm.is_file() or not occ_yaml.is_file():
        raise FileNotFoundError(f"Occupancy map missing for {name}")

    meta = meta or _read_yaml(occ_yaml)
    keepout_pgm, keepout_yaml = layer_paths(maps_root, name, "keepout")
    speed_pgm, speed_yaml = layer_paths(maps_root, name, "speed")

    # Keepout mirrors the occupancy map's thresholds and the unpainted pixel are set to unknown
    occ_free = float(meta.get("free_thresh", TRINARY_FREE_THRESH))
    occ_occupied = float(meta.get("occupied_thresh", DEFAULT_OCCUPIED_THRESH))
    _, unknown_pixel = trinary_pixel_bounds(occ_free, occ_occupied)
    if not keepout_pgm.is_file():
        blank_mask_like(occ_pgm, unknown_pixel).save(keepout_pgm)
    if not keepout_yaml.is_file():
        ky = {
            "image": keepout_pgm.name,
            "mode": "trinary",
            "resolution": meta.get("resolution", 0.05),
            "origin": meta.get("origin", [0.0, 0.0, 0.0]),
            "negate": 0,
            "occupied_thresh": occ_occupied,
            "free_thresh": occ_free,
        }
        _write_yaml(keepout_yaml, ky)

    if not speed_pgm.is_file():
        blank_mask_like(occ_pgm, SPEED_DEFAULT).save(speed_pgm)
    if not speed_yaml.is_file():
        sy = {
            "image": speed_pgm.name,
            "mode": "scale",
            "resolution": meta.get("resolution", 0.05),
            "origin": meta.get("origin", [0.0, 0.0, 0.0]),
            "negate": 0,
            "occupied_thresh": 1.0,
            "free_thresh": 0.0,
        }
        _write_yaml(speed_yaml, sy)

    semantic_pgm, semantic_yaml = layer_paths(maps_root, name, "semantic")
    legacy_semantic = semantic_pgm.with_suffix(".pgm")
    if not semantic_pgm.is_file() and legacy_semantic.is_file():
        old = Image.open(legacy_semantic).convert("L")
        _write_semantic_image(
            semantic_pgm, old.size, list(old.getdata()), load_semantic_regions(maps_root, name)
        )
        legacy_semantic.unlink()
    if not semantic_pgm.is_file():
        size = Image.open(occ_pgm).size
        _write_semantic_image(
            semantic_pgm, size, [SEMANTIC_NONE] * (size[0] * size[1]), []
        )
    if not semantic_yaml.is_file():
        # Written for symmetry with the other layers.
        _write_yaml(
            semantic_yaml,
            {
                "image": semantic_pgm.name,
                "mode": "raw",
                "resolution": meta.get("resolution", 0.05),
                "origin": meta.get("origin", [0.0, 0.0, 0.0]),
                "negate": 0,
            },
        )
    binary_pgm, binary_yaml = layer_paths(maps_root, name, "binary")
    if not binary_pgm.is_file():
        blank_mask_like(occ_pgm, BINARY_OFF).save(binary_pgm)
    if not binary_yaml.is_file():
        _write_yaml(
            binary_yaml,
            {
                "image": binary_pgm.name,
                "mode": "scale",
                "resolution": meta.get("resolution", 0.05),
                "origin": meta.get("origin", [0.0, 0.0, 0.0]),
                "negate": 0,
                "occupied_thresh": 1.0,
                "free_thresh": 0.0,
            },
        )

    sem_json = semantic_json_path(maps_root, name)
    if not sem_json.is_file():
        sem_json.write_text('{"regions": []}\n', encoding="utf-8")

    loc = locations_path(maps_root, name)
    if not loc.is_file():
        loc.write_text("[]\n", encoding="utf-8")


def save_map_from_slam(maps_root: Path, name: str, timeout: float = 15.0) -> dict:
    """Save maps/<name>/map.{pgm,yaml} + sidecars from the live map.

    Uses nav2's /map_saver/save_map service (map_saver_server, added to the
    mapping launch). The service client runs in-process on the backend's rclpy
    node.
    """
    # Imported lazily so maps_api stays importable without a ROS install.
    from stretch4_nav_webapp.nav_actions import save_map_via_service

    ensure_maps_root(maps_root)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name.strip())
    if not safe:
        raise ValueError("Invalid map name")
    dest = map_dir(maps_root, safe)
    dest.mkdir(parents=True, exist_ok=True)

    logger.info("Saving map %s via /map_saver/save_map service", safe)
    save_map_via_service(str(dest / "map"), map_topic="/map", timeout_sec=timeout)
    if not (dest / "map.pgm").is_file():
        raise RuntimeError("map save did not produce map.pgm")
    create_sidecar_layers(maps_root, safe)
    return {"ok": True, "name": safe, "path": str(dest)}


def _painted_below(meta: dict) -> int:
    free = float(meta.get("free_thresh", TRINARY_FREE_THRESH))
    occupied = float(meta.get("occupied_thresh", DEFAULT_OCCUPIED_THRESH))
    if meta.get("mode", "trinary") == "scale":
        threshold = free + 0.005 * (occupied - free)
    else:
        threshold = occupied
    return math.ceil(255 * (1.0 - threshold))


def _mask_painted(pgm_path: Path, yaml_path: Path) -> bool:
    """True if the mask has any pixel nav2 would act on.

    The cutoff is derived from the mask's own YAML (mode and thresholds),
    """
    try:
        meta = _read_yaml(yaml_path)
        image = meta.get("image")
        path = yaml_path.parent / image if image else pgm_path
        if not path.is_file():
            path = pgm_path
        lo, _ = Image.open(path).convert("L").getextrema()
        return lo < _painted_below(meta)
    except Exception:  # noqa: BLE001
        return True


# Stems that belong to a map's sidecar layers, not to a map of their own.
SIDECAR_STEMS = {"keepout", "speed", "semantic", "binary_filter_mask"}
MAP_IMAGE_SUFFIX = ".pgm"


def _map_image_for(yaml_path: Path) -> Optional[Path]:
    """The image file a map YAML points at, or None if this isn't a map YAML. """
    try:
        meta = _read_yaml(yaml_path)
    except Exception:  # noqa: BLE001 - a malformed YAML is simply not a map
        return None
    if not isinstance(meta, dict) or not ({"image", "resolution"} & set(meta)):
        return None
    image = meta.get("image")
    if image:
        path = Path(str(image)).expanduser()
        if not path.is_absolute():
            path = yaml_path.parent / path
        if path.is_file() and path.suffix.lower() == MAP_IMAGE_SUFFIX:
            return path
    sibling = yaml_path.with_suffix(MAP_IMAGE_SUFFIX)
    return sibling if sibling.is_file() else None


def importable_maps(maps_root: Path) -> dict[str, Path]:
    """name -> source YAML for maps on disk that aren't in the app's layout. """
    found: dict[str, Path] = {}
    if not maps_root.is_dir():
        return found
    for child in sorted(maps_root.iterdir()):
        if child.name.startswith("."):
            continue
        if child.is_dir():
            if (child / "map.yaml").is_file():
                continue  # already in the app's layout
            candidates = [
                y
                for y in sorted(child.glob("*.yaml"))
                if y.stem not in SIDECAR_STEMS and _map_image_for(y)
            ]
            if candidates:
                found[child.name] = candidates[0]
        elif child.suffix == ".yaml" and child.stem not in SIDECAR_STEMS:
            # A folder of the same name means this flat map was already set up.
            if (maps_root / child.stem).is_dir():
                continue
            if _map_image_for(child):
                found[child.stem] = child
    return found


def import_map(maps_root: Path, name: str) -> Path:
    """Set up a foreign map as maps/<name>/map.{pgm,yaml} + sidecars.

    Copies; the user's original files are left exactly where they were, so a
    launch file or script still pointing at them keeps working.
    """
    dest = map_dir(maps_root, name)
    if (dest / "map.yaml").is_file():
        return dest
    src_yaml = importable_maps(maps_root).get(name)
    if src_yaml is None:
        raise FileNotFoundError(f"No map to set up under the name '{name}'")
    src_img = _map_image_for(src_yaml)
    if src_img is None:
        raise FileNotFoundError(f"Map image missing for '{name}' ({src_yaml})")

    dest.mkdir(parents=True, exist_ok=True)
    dest_img = dest / "map.pgm"
    if src_img.resolve() != dest_img.resolve():
        shutil.copy2(src_img, dest_img)

    meta = _read_yaml(src_yaml)
    meta["image"] = dest_img.name
    _write_yaml(dest / "map.yaml", meta)
    create_sidecar_layers(maps_root, name, meta)
    logger.info("Set up map %s from %s", name, src_yaml)
    return dest


def list_maps(maps_root: Path) -> list[dict]:
    ensure_maps_root(maps_root)
    maps: list[dict] = []
    # Folder layout
    for child in sorted(maps_root.iterdir()):
        if child.is_dir() and (child / "map.yaml").is_file():
            has_keepout = (child / "keepout.yaml").is_file()
            has_speed = (child / "speed.yaml").is_file()
            maps.append(
                {
                    "name": child.name,
                    "layout": "folder",
                    "needs_setup": False,
                    "has_keepout": has_keepout,
                    "has_speed": has_speed,
                    "keepout_painted": has_keepout
                    and _mask_painted(child / "keepout.pgm", child / "keepout.yaml"),
                    "speed_painted": has_speed
                    and _mask_painted(child / "speed.pgm", child / "speed.yaml"),
                    "semantic_regions": len(load_semantic_regions(maps_root, child.name)),
                    # Reported so the layer card can say "Painted"; navigation
                    # never reads it — the binary filter is launched by hand.
                    "binary_painted": (child / "binary_filter_mask.yaml").is_file()
                    and _mask_painted(
                        child / "binary_filter_mask.pgm", child / "binary_filter_mask.yaml"
                    ),
                    "path": str(child),
                }
            )
    # Anything else that looks like a map but isn't in the app's layout — a
    # flat <name>.yaml beside its image, or a folder whose YAML kept its
    # original name. Listed as needs_setup so the picker can offer to fix it
    # instead of silently hiding the map.
    for name, src_yaml in sorted(importable_maps(maps_root).items()):
        maps.append(
            {
                "name": name,
                "layout": "needs_setup",
                "needs_setup": True,
                "has_keepout": False,
                "has_speed": False,
                "keepout_painted": False,
                "speed_painted": False,
                "semantic_regions": 0,
                "binary_painted": False,
                "path": str(src_yaml),
                "source_yaml": str(src_yaml),
            }
        )
    return maps


def migrate_flat_map(maps_root: Path, name: str) -> Path:
    """Backwards-compatible alias for :func:`import_map`."""
    return import_map(maps_root, name)


def load_layer(maps_root: Path, name: str, layer: str) -> dict[str, Any]:
    if layer not in LAYER_FILES:
        raise ValueError(f"Unknown layer: {layer}")
    # Auto-migrate flat maps on first edit
    folder = map_dir(maps_root, name)
    if not (folder / "map.yaml").is_file():
        migrate_flat_map(maps_root, name)
    if layer != "occupancy":
        create_sidecar_layers(maps_root, name)

    pgm_path, yaml_path = layer_paths(maps_root, name, layer)
    meta = _read_yaml(yaml_path)
    img = _read_semantic_indices(pgm_path) if layer == "semantic" else Image.open(pgm_path).convert("L")
    width, height = img.size
    pixels = list(img.getdata())
    return {
        "name": name,
        "layer": layer,
        "width": width,
        "height": height,
        "resolution": float(meta.get("resolution", 0.05)),
        "origin": meta.get("origin", [0.0, 0.0, 0.0]),
        "negate": int(meta.get("negate", 0)),
        "occupied_thresh": float(meta.get("occupied_thresh", 0.65)),
        "free_thresh": float(meta.get("free_thresh", TRINARY_FREE_THRESH)),
        "mode": meta.get("mode", "trinary"),
        "pixels": pixels,
        "yaml_path": str(yaml_path),
        "pgm_path": str(pgm_path),
    }


def save_layer(
    maps_root: Path,
    name: str,
    layer: str,
    *,
    width: int,
    height: int,
    pixels: list[int],
    meta: Optional[dict] = None,
) -> dict:
    if layer not in LAYER_FILES:
        raise ValueError(f"Unknown layer: {layer}")
    if len(pixels) != width * height:
        raise ValueError(f"pixels length {len(pixels)} != {width}*{height}")

    folder = map_dir(maps_root, name)
    folder.mkdir(parents=True, exist_ok=True)
    if not (folder / "map.yaml").is_file() and layer != "occupancy":
        raise FileNotFoundError("Save occupancy map first")

    pgm_path, yaml_path = layer_paths(maps_root, name, layer)
    if layer == "semantic":
        _write_semantic_image(
            pgm_path, (width, height), pixels, load_semantic_regions(maps_root, name)
        )
    elif layer == "keepout":
        # Only two states are meaningful: painted keepout (lethal) and
        # everything else, stored as unknown. 
        occ_meta = _read_yaml(folder / "map.yaml")
        keepout_free = float(occ_meta.get("free_thresh", TRINARY_FREE_THRESH))
        keepout_occupied = float(
            occ_meta.get("occupied_thresh", DEFAULT_OCCUPIED_THRESH)
        )
        lethal_below, unknown_pixel = trinary_pixel_bounds(
            keepout_free, keepout_occupied
        )
        img = Image.new("L", (width, height))
        img.putdata(
            [KEEPOUT_LETHAL if int(p) < lethal_below else unknown_pixel for p in pixels]
        )
        img.save(pgm_path)
    else:
        # Clamp on the way in: the speed layer has a floor because 0 means "no
        # limit" to Nav2, not "stop" (see SPEED_MIN).
        lo = SPEED_MIN if layer == "speed" else 0
        img = Image.new("L", (width, height))
        img.putdata([max(lo, min(255, int(p))) for p in pixels])
        img.save(pgm_path)

    existing = _read_yaml(yaml_path) if yaml_path.is_file() else {}
    if meta:
        existing.update(meta)
    existing["image"] = pgm_path.name
    existing.setdefault("resolution", 0.05)
    existing.setdefault("origin", [0.0, 0.0, 0.0])
    existing.setdefault("negate", 0)
    if layer in ("speed", "binary"):
        existing.setdefault("mode", "scale")
        existing.setdefault("occupied_thresh", 1.0)
        existing.setdefault("free_thresh", 0.0)
    elif layer == "semantic":
        existing.setdefault("mode", "raw")
        existing.pop("occupied_thresh", None)
        existing.pop("free_thresh", None)
    elif layer == "keepout":
        existing.setdefault("mode", "trinary")
        existing["occupied_thresh"] = keepout_occupied
        existing["free_thresh"] = keepout_free
    else:
        existing.setdefault("mode", "trinary")
        existing.setdefault("occupied_thresh", 0.65)
        existing.setdefault("free_thresh", TRINARY_FREE_THRESH)
    _write_yaml(yaml_path, existing)

    if layer == "occupancy":
        create_sidecar_layers(maps_root, name, existing)

    return {"ok": True, "name": name, "layer": layer, "path": str(pgm_path)}


def load_semantic_regions(maps_root: Path, name: str) -> list[dict]:
    """The id -> name/colour table for the semantic layer.

    Ids are the pixel values in semantic.pgm, so they must stay in 1..255 and
    must never be reused for a different room while old pixels still carry them.
    """
    path = semantic_json_path(maps_root, name)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except json.JSONDecodeError:
        logger.warning("semantic.json for %s is not valid JSON; treating as empty", name)
        return []
    regions = data.get("regions") if isinstance(data, dict) else data
    return regions if isinstance(regions, list) else []


def save_semantic_regions(maps_root: Path, name: str, regions: list[dict]) -> list[dict]:
    seen: set[int] = set()
    clean: list[dict] = []
    for r in regions:
        rid = int(r.get("id", 0))
        if not 1 <= rid <= 255:
            raise ValueError(f"Region id {rid} out of range 1..255")
        if rid in seen:
            raise ValueError(f"Duplicate region id {rid}")
        seen.add(rid)
        label = str(r.get("name", "")).strip()
        if not label:
            raise ValueError(f"Region {rid} has no name")
        clean.append({"id": rid, "name": label, "color": str(r.get("color") or "#3d9cf0")})

    # A deleted room's paint has to go with it. Left behind, those pixels carry
    # an id nothing names — they render as a hole, and a later room reusing the
    # id would silently adopt them.
    dropped = {r["id"] for r in load_semantic_regions(maps_root, name)} - seen
    img_path, _ = layer_paths(maps_root, name, "semantic")
    if img_path.is_file():
        img = _read_semantic_indices(img_path)
        data = list(img.getdata())
        if dropped:
            data = [0 if v in dropped else v for v in data]
        _write_semantic_image(img_path, img.size, data, clean)

    path = semantic_json_path(maps_root, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"regions": clean}, indent=2) + "\n", encoding="utf-8")
    return clean


def load_locations(maps_root: Path, name: str) -> list[dict]:
    path = locations_path(maps_root, name)
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8") or "[]")
    return data if isinstance(data, list) else []


def save_locations(maps_root: Path, name: str, locations: list[dict]) -> list[dict]:
    path = locations_path(maps_root, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(locations, indent=2) + "\n", encoding="utf-8")
    return locations
