"""The charging dock marked on a map.

Stored per map as ``maps/<name>/docks.yaml``, in the same version 1.0 schema as
stretch_nav2's dock database (``DockDatabase``)::

    version: '1.0'
    docks:
      dock_1:
        timestamp: '2026-10-07T12:00:00'
        pose:
          position: [x, y, z]
          orientation: [qx, qy, qz, qw]

so a file written here can be handed to the docking server's
ReloadDockDatabase, and one written by discover_dock reads here unchanged.

A map with no ``docks.yaml`` of its own falls back to the database
discover_dock writes for a map of the same name,
``<maps_root>/docks/<name>_docks.yaml``. Saving always writes the map's own
file; the discover_dock database is never modified.
"""

from __future__ import annotations

import logging
import math
import time
from pathlib import Path
from typing import Optional

import yaml

from stretch4_nav_webapp.paths import dock_path, map_dir

logger = logging.getLogger(__name__)

DATABASE_VERSION = "1.0"
DOCK_ID = "dock_1"


def discovered_dock_path(maps_root: Path, name: str) -> Path:
    """Where stretch_nav2's discover_dock saves docks for the map ``name``."""
    return maps_root / "docks" / f"{name}_docks.yaml"


def _yaw_from_quaternion(q: list) -> float:
    x, y, z, w = (float(v) for v in q)
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def read_first_dock(path: Path) -> Optional[dict]:
    """The first dock (by id) in a v1.0 dock database, or None."""
    if not path.is_file():
        return None
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning("cannot read dock database %s: %s", path, exc)
        return None
    if str(data.get("version")) != DATABASE_VERSION:
        logger.warning("dock database %s: unsupported version %r", path, data.get("version"))
        return None
    docks = data.get("docks")
    if not isinstance(docks, dict) or not docks:
        return None
    dock_id = sorted(docks)[0]
    try:
        pose = docks[dock_id]["pose"]
        position = [float(v) for v in pose["position"]]
        orientation = [float(v) for v in pose["orientation"]]
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning("dock database %s: malformed entry %s: %s", path, dock_id, exc)
        return None
    return {
        "id": str(dock_id),
        "x": position[0],
        "y": position[1],
        "yaw": _yaw_from_quaternion(orientation),
    }


def load_dock(maps_root: Path, name: str) -> Optional[dict]:
    """``{id, x, y, yaw, source}`` for the map's dock, or None if it has none.

    ``source`` is ``"map"`` for the map's own docks.yaml and ``"discovered"``
    for discover_dock's database.
    """
    dock = read_first_dock(dock_path(maps_root, name))
    if dock:
        return {**dock, "source": "map"}
    dock = read_first_dock(discovered_dock_path(maps_root, name))
    if dock:
        return {**dock, "source": "discovered"}
    return None


def save_dock(maps_root: Path, name: str, x: float, y: float, yaw: float) -> dict:
    """Mark the map's dock at (x, y, yaw), replacing any dock marked before."""
    if not (map_dir(maps_root, name) / "map.yaml").is_file():
        raise FileNotFoundError(f"Map '{name}' not found")
    half = float(yaw) / 2.0
    data = {
        "version": DATABASE_VERSION,
        "docks": {
            DOCK_ID: {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "pose": {
                    "position": [float(x), float(y), 0.0],
                    "orientation": [0.0, 0.0, math.sin(half), math.cos(half)],
                },
            }
        },
    }
    path = dock_path(maps_root, name)
    path.write_text(yaml.safe_dump(data, default_flow_style=False), encoding="utf-8")
    return load_dock(maps_root, name)


def delete_dock(maps_root: Path, name: str) -> Optional[dict]:
    """Remove the map's own dock. A discovered dock, if any, shows through again."""
    dock_path(maps_root, name).unlink(missing_ok=True)
    return load_dock(maps_root, name)


def rotate_dock(maps_root: Path, name: str, cx: float, cy: float, theta: float) -> bool:
    """Turn the map's own dock about (cx, cy) by theta, as a map rotation does.

    Returns True if there was a dock to move.
    """
    dock = read_first_dock(dock_path(maps_root, name))
    if not dock:
        return False
    c, s = math.cos(theta), math.sin(theta)
    dx, dy = dock["x"] - cx, dock["y"] - cy
    save_dock(maps_root, name, cx + c * dx - s * dy, cy + s * dx + c * dy, dock["yaw"] + theta)
    return True
