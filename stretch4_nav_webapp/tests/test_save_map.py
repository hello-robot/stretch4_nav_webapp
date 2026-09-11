"""Tests for saving the live map via the nav2 SaveMap service.

`save_map_from_slam` calls `save_map_via_service` (which invokes map_saver over
rclpy) and then builds the editable keepout/speed sidecars. The service call
needs ROS, so it's stubbed here to emulate map_saver writing map.pgm/map.yaml;
the test verifies the orchestration: correct output prefix, and that the saved
map is set up so the editor's loader (`load_layer`) reads it back.
"""

import tempfile
from pathlib import Path

from PIL import Image

import stretch4_nav_webapp.nav_actions as nav_actions
from stretch4_nav_webapp import maps_api
from stretch4_nav_webapp.maps_api import load_layer, save_map_from_slam


def _install_fake_saver(monkeypatch, calls):
    def fake(map_url, map_topic="/map", timeout_sec=15.0):
        calls.append({"map_url": map_url, "map_topic": map_topic})
        prefix = Path(map_url)
        prefix.parent.mkdir(parents=True, exist_ok=True)
        # Emulate map_saver output: <map_url>.pgm + <map_url>.yaml.
        Image.new("L", (4, 3), color=maps_api.OCC_FREE).save(
            prefix.with_suffix(".pgm")
        )
        prefix.with_suffix(".yaml").write_text(
            "image: map.pgm\nmode: trinary\nresolution: 0.05\n"
            "origin: [-1.0, -2.0, 0.0]\nnegate: 0\n"
            "occupied_thresh: 0.65\nfree_thresh: 0.25\n"
        )
        return {"ok": True}

    monkeypatch.setattr(nav_actions, "save_map_via_service", fake)


def test_save_calls_service_with_map_prefix(monkeypatch):
    calls = []
    _install_fake_saver(monkeypatch, calls)
    root = Path(tempfile.mkdtemp())

    res = save_map_from_slam(root, "down")

    assert res["ok"] and res["name"] == "down"
    assert len(calls) == 1
    # map_saver writes <prefix>.pgm/.yaml, so the prefix must be maps/down/map.
    assert calls[0]["map_url"] == str(root / "down" / "map")
    assert calls[0]["map_topic"] == "/map"
    assert (root / "down" / "map.pgm").is_file()


def test_save_creates_editable_sidecars(monkeypatch):
    _install_fake_saver(monkeypatch, [])
    root = Path(tempfile.mkdtemp())
    save_map_from_slam(root, "down")

    # Saving must leave the map loadable and the keepout/speed masks editable.
    occ = load_layer(root, "down", "occupancy")
    assert (occ["width"], occ["height"]) == (4, 3)
    assert occ["origin"] == [-1.0, -2.0, 0.0]

    keepout = load_layer(root, "down", "keepout")
    speed = load_layer(root, "down", "speed")
    assert (keepout["width"], keepout["height"]) == (4, 3)
    assert speed["mode"] == "scale"


def test_invalid_name_rejected(monkeypatch):
    _install_fake_saver(monkeypatch, [])
    root = Path(tempfile.mkdtemp())
    try:
        save_map_from_slam(root, "   ")
        assert False, "expected ValueError for empty name"
    except ValueError:
        pass
