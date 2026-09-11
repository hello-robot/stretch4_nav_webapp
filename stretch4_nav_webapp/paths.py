"""Shared path helpers for maps storage."""

from __future__ import annotations

import os
from pathlib import Path


LAYER_FILES = {
    "occupancy": ("map.pgm", "map.yaml"),
    "keepout": ("keepout.pgm", "keepout.yaml"),
    "speed": ("speed.pgm", "speed.yaml"),
    "semantic": ("semantic.png", "semantic.yaml"),
    "binary": ("binary_filter_mask.pgm", "binary_filter_mask.yaml"),
}


def default_maps_dir() -> Path:
    fleet = os.environ.get("HELLO_FLEET_PATH")
    if fleet:
        return Path(fleet).expanduser() / "maps"
    return Path.home() / "stretch_user" / "maps"


def map_dir(maps_root: Path, name: str) -> Path:
    return maps_root / name


def layer_paths(maps_root: Path, name: str, layer: str) -> tuple[Path, Path]:
    if layer not in LAYER_FILES:
        raise ValueError(f"Unknown layer: {layer}")
    pgm, yaml_name = LAYER_FILES[layer]
    root = map_dir(maps_root, name)
    return root / pgm, root / yaml_name


def locations_path(maps_root: Path, name: str) -> Path:
    return map_dir(maps_root, name) / "locations.json"


def semantic_json_path(maps_root: Path, name: str) -> Path:
    """Region id -> name/colour table for the semantic layer."""
    return map_dir(maps_root, name) / "semantic.json"


def backup_dir(maps_root: Path, name: str) -> Path:
    """Where crop/rotate stashes the pre-transform copy of every layer."""
    return map_dir(maps_root, name) / ".before_transform"


def occupancy_yaml(maps_root: Path, name: str) -> Path:
    return layer_paths(maps_root, name, "occupancy")[1]
