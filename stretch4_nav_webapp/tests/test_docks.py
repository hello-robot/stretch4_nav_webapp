"""The per-map charging dock: storage, discover_dock fallback, and map rotation."""

import math
import tempfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from stretch4_nav_webapp.app import create_app
from stretch4_nav_webapp.docks import (
    delete_dock,
    discovered_dock_path,
    load_dock,
    rotate_dock,
    save_dock,
)


@pytest.fixture
def maps_root():
    root = Path(tempfile.mkdtemp())
    (root / "down").mkdir()
    (root / "down" / "map.yaml").write_text("image: map.pgm\nresolution: 0.05\n")
    return root


def _write_discovered(root, name, position, orientation):
    path = discovered_dock_path(root, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump({
        "version": "1.0",
        "docks": {"dock_1": {"pose": {"position": position, "orientation": orientation}}},
    }))


def test_no_dock(maps_root):
    assert load_dock(maps_root, "down") is None


def test_save_round_trips_in_dock_database_schema(maps_root):
    dock = save_dock(maps_root, "down", 1.5, -2.0, 2.5)
    assert dock["source"] == "map"
    assert (dock["x"], dock["y"]) == (1.5, -2.0)
    assert dock["yaw"] == pytest.approx(2.5)

    # Readable by stretch_nav2's DockDatabase: version 1.0, docks dict, pose lists.
    data = yaml.safe_load((maps_root / "down" / "docks.yaml").read_text())
    assert data["version"] == "1.0"
    pose = data["docks"]["dock_1"]["pose"]
    assert pose["position"] == [1.5, -2.0, 0.0]
    assert pose["orientation"][2] == pytest.approx(math.sin(1.25))
    assert pose["orientation"][3] == pytest.approx(math.cos(1.25))


def test_save_replaces_previous_dock(maps_root):
    save_dock(maps_root, "down", 1.0, 1.0, 0.0)
    dock = save_dock(maps_root, "down", 3.0, 4.0, 0.0)
    assert (dock["x"], dock["y"]) == (3.0, 4.0)


def test_save_needs_the_map(maps_root):
    with pytest.raises(FileNotFoundError):
        save_dock(maps_root, "nope", 0.0, 0.0, 0.0)


def test_falls_back_to_discover_dock_database(maps_root):
    half = 0.3
    _write_discovered(maps_root, "down", [2.0, 3.0, 0.05], [0.0, 0.0, math.sin(half), math.cos(half)])
    dock = load_dock(maps_root, "down")
    assert dock["source"] == "discovered"
    assert dock["yaw"] == pytest.approx(2 * half)

    # The map's own dock wins, and deleting it lets the discovered one show again.
    save_dock(maps_root, "down", 9.0, 9.0, 0.0)
    assert load_dock(maps_root, "down")["source"] == "map"
    assert delete_dock(maps_root, "down")["source"] == "discovered"
    assert discovered_dock_path(maps_root, "down").is_file()


def test_unsupported_version_is_ignored(maps_root):
    (maps_root / "down" / "docks.yaml").write_text("version: '2.0'\ndocks: {}\n")
    assert load_dock(maps_root, "down") is None


def test_rotate_dock_turns_with_the_map(maps_root):
    save_dock(maps_root, "down", 2.0, 0.0, 0.0)
    assert rotate_dock(maps_root, "down", 1.0, 0.0, math.pi / 2)
    dock = load_dock(maps_root, "down")
    assert dock["x"] == pytest.approx(1.0)
    assert dock["y"] == pytest.approx(1.0)
    assert dock["yaw"] == pytest.approx(math.pi / 2)


def test_rotate_leaves_discovered_dock_alone(maps_root):
    _write_discovered(maps_root, "down", [2.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])
    assert not rotate_dock(maps_root, "down", 0.0, 0.0, 1.0)


def test_dock_endpoints(maps_root):
    client = TestClient(create_app(maps_dir=maps_root))
    assert client.get("/api/maps/down/dock").json() == {"dock": None}
    put = client.put("/api/maps/down/dock", json={"x": 1.0, "y": 2.0, "yaw": 0.5})
    assert put.status_code == 200
    assert put.json()["dock"]["x"] == 1.0
    assert client.get("/api/maps/down/dock").json()["dock"]["yaw"] == pytest.approx(0.5)
    assert client.delete("/api/maps/down/dock").json() == {"dock": None}
    assert client.put("/api/maps/nope/dock", json={"x": 0, "y": 0}).status_code == 404


def test_dock_needs_navigation(maps_root):
    client = TestClient(create_app(maps_dir=maps_root))
    assert client.post("/api/navigation/dock").status_code == 409
