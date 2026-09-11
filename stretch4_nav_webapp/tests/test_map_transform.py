"""Crop/rotate geometry: layers stay registered, locations stay on target.

The whole point of transform_map is that a world position keeps pointing at the
same map feature afterwards, so every test here checks a *feature*, not just an
image size.
"""

import json
import math
from pathlib import Path

import yaml
from PIL import Image

from stretch4_nav_webapp.map_transform import explored_bounds, restore_backup, transform_map
from stretch4_nav_webapp.maps_api import create_sidecar_layers
from stretch4_nav_webapp.paths import layer_paths, locations_path

RES = 0.05
W, H = 40, 30
# The mark is the feature we track through every transform.
MARK_COL, MARK_ROW = 12, 7  # image coords, row 0 at the top


def _world_of(col: int, row: int, origin, height: int, res: float = RES):
    """World centre of an image cell, the way map_server counts (j from bottom)."""
    return (origin[0] + (col + 0.5) * res, origin[1] + (height - 1 - row + 0.5) * res)


def _find_mark(pgm: Path, value: int = 0) -> tuple[int, int]:
    img = Image.open(pgm).convert("L")
    px = img.load()
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            if px[x, y] == value:
                return x, y
    raise AssertionError("mark not found")


def _make_map(tmp_path: Path, name: str = "m", origin=(-1.0, -2.0, 0.0)) -> Path:
    folder = tmp_path / name
    folder.mkdir()
    img = Image.new("L", (W, H), color=205)  # all unknown
    # A blob of known space with a single black mark inside it.
    for y in range(5, 20):
        for x in range(8, 30):
            img.putpixel((x, y), 254)
    img.putpixel((MARK_COL, MARK_ROW), 0)
    img.save(folder / "map.pgm")
    (folder / "map.yaml").write_text(
        yaml.safe_dump(
            {
                "image": "map.pgm",
                "resolution": RES,
                "origin": list(origin),
                "negate": 0,
                "occupied_thresh": 0.65,
                "free_thresh": 0.196,  # map_saver's convention; keeps 205 = unknown
                "mode": "trinary",
            }
        ),
        encoding="utf-8",
    )
    create_sidecar_layers(tmp_path, name)
    return folder


def _put_location_on_mark(tmp_path: Path, name: str, origin, height: int) -> dict:
    wx, wy = _world_of(MARK_COL, MARK_ROW, origin, height)
    loc = {"id": "l0", "name": "mark", "x": wx, "y": wy, "yaw": 0.0}
    locations_path(tmp_path, name).write_text(json.dumps([loc]), encoding="utf-8")
    return loc


def test_sidecars_include_semantic(tmp_path: Path):
    _make_map(tmp_path)
    sem_img, sem_yaml = layer_paths(tmp_path, "m", "semantic")
    assert sem_img.is_file() and sem_yaml.is_file()
    img = Image.open(sem_img)
    assert img.size == (W, H)
    # Indexed colour: the stored value is the room id, and id 0 (unlabelled)
    # shows as white so the file is viewable instead of being a black square.
    assert img.mode == "P"
    assert set(img.getdata()) == {0}
    assert tuple(img.getpalette()[0:3]) == (255, 255, 255)
    assert json.loads((tmp_path / "m" / "semantic.json").read_text()) == {"regions": []}


def test_semantic_ids_survive_crop_and_rotate(tmp_path: Path):
    """Indexed colour is a display trick — the stored value is still the room id.

    Rotating through PIL must not remap those ids through the palette, or every
    room silently becomes a different room.
    """
    from stretch4_nav_webapp.maps_api import save_layer, save_semantic_regions

    _make_map(tmp_path)
    save_semantic_regions(
        tmp_path, "m", [{"id": 1, "name": "Kitchen", "color": "#e6a23c"}]
    )
    pixels = [1 if (10 <= i % W < 20 and 10 <= i // W < 20) else 0 for i in range(W * H)]
    save_layer(tmp_path, "m", "semantic", width=W, height=H, pixels=pixels)
    painted_before = pixels.count(1)

    transform_map(tmp_path, "m", rotate_deg=90.0)
    img = Image.open(layer_paths(tmp_path, "m", "semantic")[0])
    assert img.mode == "P"
    assert set(img.getdata()) == {0, 1}
    assert list(img.getdata()).count(1) == painted_before
    # The room's colour rode along, so the file still opens as coloured rooms.
    assert tuple(img.getpalette()[3:6]) == (0xE6, 0xA2, 0x3C)


def test_crop_keeps_world_positions(tmp_path: Path):
    origin = (-1.0, -2.0, 0.0)
    _make_map(tmp_path, origin=origin)
    _put_location_on_mark(tmp_path, "m", origin, H)
    before = json.loads(locations_path(tmp_path, "m").read_text())[0]

    res = transform_map(tmp_path, "m", crop={"left": 6, "top": 4, "width": 26, "height": 18})
    assert (res["width"], res["height"]) == (26, 18)

    # Every layer cropped to the same size — a mask left at the old size would
    # misregister against the map.
    for layer in ("occupancy", "keepout", "speed", "semantic"):
        pgm, yml = layer_paths(tmp_path, "m", layer)
        assert Image.open(pgm).size == (26, 18), layer
        assert yaml.safe_load(yml.read_text())["origin"] == res["origin"], layer

    # The mark moved in the image but not in the world.
    col, row = _find_mark(tmp_path / "m" / "map.pgm")
    assert (col, row) == (MARK_COL - 6, MARK_ROW - 4)
    wx, wy = _world_of(col, row, res["origin"], res["height"])
    assert math.isclose(wx, before["x"], abs_tol=1e-9)
    assert math.isclose(wy, before["y"], abs_tol=1e-9)

    # Crop moves nothing in the world, so locations are left alone.
    after = json.loads(locations_path(tmp_path, "m").read_text())[0]
    assert after["x"] == before["x"] and after["y"] == before["y"]
    assert res["locations_moved"] == 0


def test_rotation_carries_locations_with_the_map(tmp_path: Path):
    """After a rotation the saved location must still land on the mark."""
    origin = (-1.0, -2.0, 0.0)
    _make_map(tmp_path, origin=origin)
    _put_location_on_mark(tmp_path, "m", origin, H)

    res = transform_map(tmp_path, "m", rotate_deg=90.0)
    assert (res["width"], res["height"]) == (H, W)  # 90° swaps the axes
    assert res["locations_moved"] == 1
    assert res["locations_off_map"] == 0

    loc = json.loads(locations_path(tmp_path, "m").read_text())[0]
    col, row = _find_mark(tmp_path / "m" / "map.pgm")
    wx, wy = _world_of(col, row, res["origin"], res["height"])
    # Within half a cell of the mark's new world position.
    assert math.hypot(wx - loc["x"], wy - loc["y"]) <= RES
    assert math.isclose(loc["yaw"], math.pi / 2, abs_tol=1e-9)

    # Heading turned with the map, and the yaml origin stayed axis-aligned.
    assert yaml.safe_load((tmp_path / "m" / "map.yaml").read_text())["origin"][2] == 0.0

    # The origin moved (the canvas grew), and *every* layer's yaml carries the
    # same new one — a sidecar left on the old origin would draw offset from
    # the map it is supposed to mask.
    assert res["origin"][:2] != [-1.0, -2.0]
    for layer in ("occupancy", "keepout", "speed", "semantic", "binary"):
        meta = yaml.safe_load(layer_paths(tmp_path, "m", layer)[1].read_text())
        assert meta["origin"] == res["origin"], layer
        assert meta["resolution"] == RES, layer
        assert Image.open(layer_paths(tmp_path, "m", layer)[0]).size == (res["width"], res["height"])


def test_rotation_fills_new_corners_with_unknown(tmp_path: Path):
    """The canvas a rotation exposes is unexplored, not free floor."""
    _make_map(tmp_path)
    transform_map(tmp_path, "m", rotate_deg=30.0)
    img = Image.open(tmp_path / "m" / "map.pgm").convert("L")
    assert img.getpixel((0, 0)) == 205
    assert img.getpixel((img.size[0] - 1, 0)) == 205
    # Masks fill with their own "no restriction" value; keepout uses unknown,
    # which the keepout filter ignores just like unpainted cells.
    assert Image.open(tmp_path / "m" / "keepout.pgm").convert("L").getpixel((0, 0)) == 205
    assert Image.open(tmp_path / "m" / "speed.pgm").convert("L").getpixel((0, 0)) == 255
    assert Image.open(tmp_path / "m" / "semantic.png").getpixel((0, 0)) == 0


def test_rotation_does_not_invent_pixel_values(tmp_path: Path):
    """NEAREST only — an interpolated occupancy grid is meaningless."""
    _make_map(tmp_path)
    transform_map(tmp_path, "m", rotate_deg=37.0)
    values = set(Image.open(tmp_path / "m" / "map.pgm").convert("L").getdata())
    assert values <= {0, 205, 254}


def test_explored_bounds_trims_to_seen_area(tmp_path: Path):
    _make_map(tmp_path)
    b = explored_bounds(tmp_path, "m", margin=0)
    assert b == {"left": 8, "top": 5, "width": 22, "height": 15}
    # The margin is clamped to the image, never negative.
    padded = explored_bounds(tmp_path, "m", margin=100)
    assert padded == {"left": 0, "top": 0, "width": W, "height": H}


def test_remove_mode_wipes_box_and_keeps_size(tmp_path: Path):
    """crop_mode="remove": box contents go blank, geometry stays put."""
    from stretch4_nav_webapp.maps_api import save_layer, save_semantic_regions

    origin = (-1.0, -2.0, 0.0)
    _make_map(tmp_path, origin=origin)
    _put_location_on_mark(tmp_path, "m", origin, H)

    # Paint every sidecar non-default across the box boundary, so the wipe
    # assertions cannot pass vacuously on blank masks.
    save_semantic_regions(tmp_path, "m", [{"id": 5, "name": "Zone"}])
    for layer, painted in (("keepout", 0), ("speed", 100), ("semantic", 5), ("binary", 153)):
        save_layer(tmp_path, "m", layer, width=W, height=H, pixels=[painted] * (W * H))

    # Box covering the mark (image coords).
    res = transform_map(
        tmp_path,
        "m",
        crop={"left": 10, "top": 5, "width": 8, "height": 6},
        crop_mode="remove",
    )
    assert (res["width"], res["height"]) == (W, H)
    assert res["origin"] == [-1.0, -2.0, 0.0]
    assert res["crop_mode"] == "remove"

    img = Image.open(tmp_path / "m" / "map.pgm").convert("L")
    assert img.getpixel((MARK_COL, MARK_ROW)) == 205  # mark wiped to unknown
    assert img.getpixel((9, 7)) == 254  # just outside the box, untouched
    for layer, fill, painted in (
        ("keepout", 205, 0),
        ("speed", 255, 100),
        ("semantic", 0, 5),
        ("binary", 255, 153),
    ):
        mask = Image.open(layer_paths(tmp_path, "m", layer)[0])
        if mask.mode != "P":
            mask = mask.convert("L")
        assert mask.getpixel((12, 7)) == fill, layer  # inside: wiped
        assert mask.getpixel((9, 7)) == painted, layer  # outside: preserved

    # Location kept, but flagged as sitting on wiped ground.
    locs = json.loads(locations_path(tmp_path, "m").read_text())
    assert len(locs) == 1
    assert res["locations_in_removed"] == 1
    assert res["locations_moved"] == 0

    restore_backup(tmp_path, "m")
    assert Image.open(tmp_path / "m" / "map.pgm").convert("L").getpixel((MARK_COL, MARK_ROW)) == 0


def test_undo_restores_every_layer(tmp_path: Path):
    _make_map(tmp_path)
    before = (tmp_path / "m" / "map.pgm").read_bytes()
    transform_map(tmp_path, "m", crop={"left": 6, "top": 4, "width": 20, "height": 12})
    assert (tmp_path / "m" / "map.pgm").read_bytes() != before

    restore_backup(tmp_path, "m")
    assert (tmp_path / "m" / "map.pgm").read_bytes() == before
    for layer in ("keepout", "speed", "semantic"):
        assert Image.open(layer_paths(tmp_path, "m", layer)[0]).size == (W, H)


def test_crop_outside_the_map_is_rejected(tmp_path: Path):
    _make_map(tmp_path)
    try:
        transform_map(tmp_path, "m", crop={"left": 0, "top": 0, "width": W + 5, "height": H})
    except ValueError as exc:
        assert "outside" in str(exc)
    else:
        raise AssertionError("expected ValueError")
