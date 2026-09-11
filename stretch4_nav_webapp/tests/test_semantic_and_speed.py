"""Named rooms round-trip, and the speed floor that keeps 0% from meaning full speed."""

import tempfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from PIL import Image

import stretch4_nav_webapp.app as app_mod
from stretch4_nav_webapp.maps_api import SPEED_MIN, create_sidecar_layers, load_layer, save_layer


def _map(root: Path, name: str = "m") -> Path:
    folder = root / name
    folder.mkdir()
    Image.new("L", (8, 6), color=254).save(folder / "map.pgm")
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
    create_sidecar_layers(root, name)
    return folder


@pytest.fixture
def client_root():
    root = Path(tempfile.mkdtemp())
    _map(root)
    return TestClient(app_mod.create_app(maps_dir=root)), root


def test_speed_pixels_never_reach_the_no_limit_value(tmp_path: Path):
    """0 in a speed mask means "no limit" to Nav2 — i.e. full speed.

    A user painting a zone black means the opposite, so the save path floors it.
    Stopping the robot is the keepout layer's job.
    """
    _map(tmp_path)
    save_layer(tmp_path, "m", "speed", width=8, height=6, pixels=[0] * 48)
    stored = load_layer(tmp_path, "m", "speed")["pixels"]
    assert min(stored) == SPEED_MIN
    assert 0 not in stored

    # Values above the floor are stored untouched — the pixel is the percentage.
    save_layer(tmp_path, "m", "speed", width=8, height=6, pixels=[204] * 48)
    assert set(load_layer(tmp_path, "m", "speed")["pixels"]) == {204}


def test_other_layers_are_not_floored(tmp_path: Path):
    """Only speed has the floor: a black keepout pixel is a real keepout."""
    _map(tmp_path)
    save_layer(tmp_path, "m", "keepout", width=8, height=6, pixels=[0] * 48)
    assert set(load_layer(tmp_path, "m", "keepout")["pixels"]) == {0}


def test_semantic_regions_round_trip(client_root):
    client, _ = client_root
    assert client.get("/api/maps/m/semantic").json() == {"regions": []}

    res = client.put(
        "/api/maps/m/semantic",
        json={"regions": [{"id": 1, "name": "Kitchen", "color": "#e6a23c"}]},
    )
    assert res.status_code == 200
    assert res.json()["regions"] == [{"id": 1, "name": "Kitchen", "color": "#e6a23c"}]
    assert client.get("/api/maps/m/semantic").json()["regions"][0]["name"] == "Kitchen"

    # The map list carries the count so the layer card can show it.
    rec = next(m for m in client.get("/api/maps").json()["maps"] if m["name"] == "m")
    assert rec["semantic_regions"] == 1


def test_semantic_layer_is_paintable_by_region_id(client_root):
    client, root = client_root
    client.put("/api/maps/m/semantic", json={"regions": [{"id": 7, "name": "Bedroom"}]})
    pixels = [7 if i < 10 else 0 for i in range(48)]
    res = client.post(
        "/api/maps/m/layer/semantic", json={"width": 8, "height": 6, "pixels": pixels}
    )
    assert res.status_code == 200
    stored = client.get("/api/maps/m/layer/semantic").json()["pixels"]
    assert stored.count(7) == 10
    # Never handed to Nav2, but written as a normal map so crop/rotate can move it.
    assert yaml.safe_load((root / "m" / "semantic.yaml").read_text())["mode"] == "raw"


def test_duplicate_and_out_of_range_region_ids_are_rejected(client_root):
    client, _ = client_root
    dup = client.put(
        "/api/maps/m/semantic",
        json={"regions": [{"id": 3, "name": "A"}, {"id": 3, "name": "B"}]},
    )
    assert dup.status_code == 400
    # 0 is "unlabelled", so it can never be a room.
    assert client.put("/api/maps/m/semantic", json={"regions": [{"id": 0, "name": "A"}]}).status_code == 422


def test_deleting_a_room_clears_its_paint(client_root):
    """Otherwise the pixels keep an id nothing names, and the next room inherits them."""
    client, root = client_root
    client.put(
        "/api/maps/m/semantic",
        json={"regions": [{"id": 1, "name": "Kitchen"}, {"id": 2, "name": "Hall"}]},
    )
    pixels = [1 if i < 10 else 2 if i < 20 else 0 for i in range(48)]
    client.post("/api/maps/m/layer/semantic", json={"width": 8, "height": 6, "pixels": pixels})

    client.put("/api/maps/m/semantic", json={"regions": [{"id": 2, "name": "Hall"}]})
    stored = client.get("/api/maps/m/layer/semantic").json()["pixels"]
    assert 1 not in stored
    assert stored.count(2) == 10  # the room that stayed is untouched


def test_binary_layer_is_editor_only(client_root):
    """Drawn like keepout, but nothing in this app ever launches a filter for it."""
    client, root = client_root
    folder = root / "m"
    assert (folder / "binary_filter_mask.pgm").is_file()
    meta = yaml.safe_load((folder / "binary_filter_mask.yaml").read_text())
    # The reading BinaryFilter's tutorial expects: whole grey range, no thresholds.
    assert meta["mode"] == "scale"
    assert (meta["free_thresh"], meta["occupied_thresh"]) == (0.0, 1.0)
    assert meta["negate"] == 0

    blank = client.get("/api/maps/m/layer/binary").json()
    assert set(blank["pixels"]) == {255}
    rec = next(m for m in client.get("/api/maps").json()["maps"] if m["name"] == "m")
    assert rec["binary_painted"] is False

    # 153 is the grey proven on the robot's own mask; it must survive untouched
    # (no speed-style floor is applied to this layer).
    painted = [153 if i < 12 else 255 for i in range(48)]
    assert client.post(
        "/api/maps/m/layer/binary", json={"width": 8, "height": 6, "pixels": painted}
    ).status_code == 200
    assert client.get("/api/maps/m/layer/binary").json()["pixels"].count(153) == 12
    rec = next(m for m in client.get("/api/maps").json()["maps"] if m["name"] == "m")
    assert rec["binary_painted"] is True


def test_navigation_never_launches_the_binary_filter(monkeypatch):
    """The mask is drawn here; starting a filter for it stays the user's job."""
    from stretch4_nav_webapp.app import load_config
    from stretch4_nav_webapp.modes import navigation as navigation_mod
    from stretch4_nav_webapp.modes.base import ModeContext
    from stretch4_nav_webapp.modes.navigation import NavigationMode

    monkeypatch.setattr(navigation_mod, "require_ready", lambda *_a, **_k: None)

    class _NoopPM:
        def set_active_mode(self, *args, **kwargs):
            pass

    root = Path(tempfile.mkdtemp())
    _map(root, "down")
    ctx = ModeContext(
        maps_dir=root, process_manager=_NoopPM(), config=load_config(), extras={}
    )
    res = NavigationMode().start(ctx, map_name="down", use_keepout=True, use_speed=True)
    assert not any("binary" in str(tok) for tok in res["command"])
    assert not any("binary" in k for k in res)


def test_binary_layer_follows_crop_and_rotate(client_root):
    client, root = client_root
    client.post("/api/maps/m/transform", json={"crop": {"left": 1, "top": 1, "width": 5, "height": 4}})
    assert Image.open(root / "m" / "binary_filter_mask.pgm").size == (5, 4)
    assert yaml.safe_load((root / "m" / "binary_filter_mask.yaml").read_text())["origin"] == (
        yaml.safe_load((root / "m" / "map.yaml").read_text())["origin"]
    )


def test_transform_endpoints(client_root):
    client, root = client_root
    info = client.get("/api/maps/m/transform").json()
    assert info["can_undo"] is False
    assert set(info["explored_bounds"]) == {"left", "top", "width", "height"}

    res = client.post(
        "/api/maps/m/transform",
        json={"crop": {"left": 1, "top": 1, "width": 5, "height": 4}, "rotate_deg": 0},
    )
    assert res.status_code == 200
    assert (res.json()["width"], res.json()["height"]) == (5, 4)
    assert Image.open(root / "m" / "keepout.pgm").size == (5, 4)
    assert client.get("/api/maps/m/transform").json()["can_undo"] is True

    assert client.post("/api/maps/m/transform/undo").status_code == 200
    assert Image.open(root / "m" / "map.pgm").size == (8, 6)

    # Nothing to undo any more.
    assert client.post("/api/maps/m/transform/undo").status_code == 404
    # A no-op transform is a mistake, not a silent success.
    assert client.post("/api/maps/m/transform", json={"rotate_deg": 0}).status_code == 400
