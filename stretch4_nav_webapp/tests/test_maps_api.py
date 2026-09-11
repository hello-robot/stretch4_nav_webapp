"""Basic unit tests that do not require ROS."""

from pathlib import Path

import pytest

from stretch4_nav_webapp.maps_api import (
    _mask_painted,
    create_sidecar_layers,
    import_map,
    list_maps,
    load_layer,
    save_layer,
    trinary_pixel_bounds,
)
from PIL import Image
import yaml


def test_map_roundtrip(tmp_path: Path):
    name = "unit_map"
    folder = tmp_path / name
    folder.mkdir()
    Image.new("L", (10, 8), color=254).save(folder / "map.pgm")
    (folder / "map.yaml").write_text(
        yaml.safe_dump(
            {
                "image": "map.pgm",
                "resolution": 0.05,
                "origin": [0.0, 0.0, 0.0],
                "negate": 0,
                "occupied_thresh": 0.65,
                "free_thresh": 0.196,  # what nav2's map_saver writes
                "mode": "trinary",
            }
        ),
        encoding="utf-8",
    )
    create_sidecar_layers(tmp_path, name)
    maps = list_maps(tmp_path)
    assert any(m["name"] == name for m in maps)
    keepout = load_layer(tmp_path, name, "keepout")
    assert keepout["width"] == 10
    assert keepout["height"] == 8
    assert set(keepout["pixels"]) == {205}
    speed = load_layer(tmp_path, name, "speed")
    assert speed["width"] == 10
    assert speed["height"] == 8
    assert set(speed["pixels"]) == {255}
    pixels = [0 if i < 5 else 255 for i in range(80)]
    save_layer(tmp_path, name, "keepout", width=10, height=8, pixels=pixels)
    again = load_layer(tmp_path, name, "keepout")
    assert again["pixels"][0] == 0
    # Unpainted/erased cells are stored as unknown (205, map_saver's value),
    # and free_thresh 0.196 keeps 205 in the unknown band when Nav2 loads it.
    assert again["pixels"][10] == 205
    assert again["free_thresh"] == 0.196


def test_painted_flags(tmp_path: Path):
    """Blank sidecar masks report painted=False; painted ones flip to True."""
    name = "painted_map"
    folder = tmp_path / name
    folder.mkdir()
    Image.new("L", (10, 8), color=254).save(folder / "map.pgm")
    (folder / "map.yaml").write_text(
        yaml.safe_dump(
            {
                "image": "map.pgm",
                "resolution": 0.05,
                "origin": [0.0, 0.0, 0.0],
                "negate": 0,
                "occupied_thresh": 0.65,
                "free_thresh": 0.25,
                "mode": "trinary",
            }
        ),
        encoding="utf-8",
    )
    create_sidecar_layers(tmp_path, name)

    rec = next(m for m in list_maps(tmp_path) if m["name"] == name)
    assert rec["has_keepout"] is True
    assert rec["has_speed"] is True
    assert rec["keepout_painted"] is False
    assert rec["speed_painted"] is False

    pixels = [0 if i < 5 else 255 for i in range(80)]
    save_layer(tmp_path, name, "keepout", width=10, height=8, pixels=pixels)
    rec = next(m for m in list_maps(tmp_path) if m["name"] == name)
    assert rec["keepout_painted"] is True
    assert rec["speed_painted"] is False


def test_painted_thresholds_match_nav2_loading(tmp_path: Path):
    """The painted flag flips exactly where nav2's mask loading does.

    The cutoff is derived from each mask's own YAML, not hardcoded. Trinary
    with map_saver's occupied_thresh 0.65: pixel 89 is the darkest lethal
    value, 90 already loads as unknown. Scale 0.0/1.0 (speed/binary): mask
    value rint((255 - p) / 255 * 100) first reaches 1 at p = 253. A foreign
    map with occupied_thresh 0.5 flips at 127/128 instead
    """

    def painted(pixel: int, meta: dict) -> bool:
        pgm = tmp_path / "mask.pgm"
        img = Image.new("L", (4, 4), color=255)
        img.putpixel((0, 0), pixel)
        img.save(pgm)
        yaml_path = tmp_path / "mask.yaml"
        yaml_path.write_text(
            yaml.safe_dump({"image": pgm.name, **meta}), encoding="utf-8"
        )
        return _mask_painted(pgm, yaml_path)

    trinary = {"mode": "trinary", "occupied_thresh": 0.65, "free_thresh": 0.196}
    assert painted(89, trinary)
    assert not painted(90, trinary)

    scale = {"mode": "scale", "occupied_thresh": 1.0, "free_thresh": 0.0}
    assert painted(253, scale)
    assert not painted(254, scale)

    foreign = {"mode": "trinary", "occupied_thresh": 0.5, "free_thresh": 0.196}
    assert painted(127, foreign)
    assert not painted(128, foreign)


def test_yaml_threshold_conventions(tmp_path: Path):
    """Occupancy defaults to map_saver's free_thresh; semantic drops both.

    """
    name = "thresh_map"
    folder = tmp_path / name
    folder.mkdir()
    Image.new("L", (10, 8), color=254).save(folder / "map.pgm")
    (folder / "map.yaml").write_text(
        yaml.safe_dump(
            {
                "image": "map.pgm",
                "resolution": 0.05,
                "origin": [0.0, 0.0, 0.0],
                "negate": 0,
                "occupied_thresh": 0.65,
                "free_thresh": 0.25,  # someone's existing value: keep it
                "mode": "trinary",
            }
        ),
        encoding="utf-8",
    )

    save_layer(tmp_path, name, "occupancy", width=10, height=8, pixels=[254] * 80)
    occ = yaml.safe_load((folder / "map.yaml").read_text(encoding="utf-8"))
    assert occ["free_thresh"] == 0.25
    assert occ["occupied_thresh"] == 0.65

    # Keepout mirrors whatever thresholds the occupancy map carries, and its
    # unpainted pixel is derived from them: for free_thresh 0.25 the lightest
    # not-yet-free pixel is 191, not map_saver's 205.
    save_layer(tmp_path, name, "keepout", width=10, height=8, pixels=[255] * 80)
    keep = yaml.safe_load((folder / "keepout.yaml").read_text(encoding="utf-8"))
    assert keep["free_thresh"] == 0.25
    assert keep["occupied_thresh"] == 0.65
    _, unknown_pixel = trinary_pixel_bounds(0.25, 0.65)
    assert unknown_pixel == 191
    lo, hi = Image.open(folder / "keepout.pgm").convert("L").getextrema()
    assert (lo, hi) == (191, 191)

    # A YAML missing the key gets map_saver's convention, not 0.25.
    (folder / "map.yaml").write_text(
        yaml.safe_dump({"image": "map.pgm", "mode": "trinary"}), encoding="utf-8"
    )
    save_layer(tmp_path, name, "occupancy", width=10, height=8, pixels=[254] * 80)
    occ = yaml.safe_load((folder / "map.yaml").read_text(encoding="utf-8"))
    assert occ["free_thresh"] == 0.196

    save_layer(tmp_path, name, "semantic", width=10, height=8, pixels=[0] * 80)
    sem = yaml.safe_load((folder / "semantic.yaml").read_text(encoding="utf-8"))
    assert sem["mode"] == "raw"
    assert "occupied_thresh" not in sem
    assert "free_thresh" not in sem


def test_degenerate_thresholds_rejected():
    """A YAML with no unknown band is invalid — refused, not papered over."""
    with pytest.raises(ValueError, match="occupied_thresh"):
        trinary_pixel_bounds(0.9, 0.3)
    # Sane thresholds still work, however unusual.
    assert trinary_pixel_bounds(0.196, 0.65) == (90, 205)
    assert trinary_pixel_bounds(0.25, 0.65) == (90, 191)


def _write_map(folder: Path, stem: str, image_name: str | None = None) -> None:
    """A nav2-style map pair with whatever names the caller wants."""
    folder.mkdir(parents=True, exist_ok=True)
    image = image_name or f"{stem}.pgm"
    Image.new("L", (12, 8), color=254).save(folder / image)
    (folder / f"{stem}.yaml").write_text(
        yaml.safe_dump(
            {
                "image": image,
                "resolution": 0.05,
                "origin": [-1.0, -2.0, 0.0],
                "negate": 0,
                "occupied_thresh": 0.65,
                "free_thresh": 0.196,
            }
        ),
        encoding="utf-8",
    )


def test_foreign_maps_are_listed_as_needing_setup(tmp_path: Path):
    _write_map(tmp_path, "my_lab")  # flat pair, arbitrary stem
    _write_map(tmp_path / "handed_over", "handed_over")  # folder, no map.yaml
    _write_map(tmp_path / "weird", "floorplan", image_name="scan.pgm")  # nothing matches

    by_name = {m["name"]: m for m in list_maps(tmp_path)}
    assert set(by_name) == {"my_lab", "handed_over", "weird"}
    assert all(m["needs_setup"] for m in by_name.values())


def test_non_maps_are_not_listed(tmp_path: Path):
    (tmp_path / "nav2_params.yaml").write_text(
        yaml.safe_dump({"amcl": {"ros__parameters": {"alpha1": 0.2}}}), encoding="utf-8"
    )
    # nav2 is fed PGMs here, so a YAML pointing at any other image is not a map.
    Image.new("L", (4, 4), color=0).save(tmp_path / "sketch.png")
    (tmp_path / "sketch.yaml").write_text(
        yaml.safe_dump({"image": "sketch.png", "resolution": 0.05}), encoding="utf-8"
    )
    assert list_maps(tmp_path) == []


def test_import_map_converts_and_keeps_originals(tmp_path: Path):
    _write_map(tmp_path / "weird", "floorplan", image_name="scan.pgm")
    import_map(tmp_path, "weird")

    folder = tmp_path / "weird"
    meta = yaml.safe_load((folder / "map.yaml").read_text(encoding="utf-8"))
    assert meta["image"] == "map.pgm"
    assert meta["origin"] == [-1.0, -2.0, 0.0]  # the user's metadata survives
    assert (folder / "map.pgm").is_file()
    assert (folder / "keepout.yaml").is_file() and (folder / "speed.yaml").is_file()
    # The files the user put there are still there.
    assert (folder / "scan.pgm").is_file() and (folder / "floorplan.yaml").is_file()

    rec = next(m for m in list_maps(tmp_path) if m["name"] == "weird")
    assert rec["needs_setup"] is False and rec["layout"] == "folder"
    # Running it twice must not produce a second entry or fail.
    import_map(tmp_path, "weird")
    assert len(list_maps(tmp_path)) == 1


def test_import_map_unknown_name(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        import_map(tmp_path, "nothing_here")
