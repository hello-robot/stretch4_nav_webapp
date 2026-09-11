"""Regression tests for the navigation launch command construction.

An empty ``name:=`` token makes ``ros2 launch`` abort with "malformed launch
argument", so a disabled filter's mask path must be omitted entirely rather
than emitted as ``speed_mask:=`` / ``keepout_mask:=``.
"""

import tempfile
from pathlib import Path

import pytest

from stretch4_nav_webapp.app import load_config
from stretch4_nav_webapp.modes.base import ModeContext
from stretch4_nav_webapp.modes import navigation as navigation_mod
from stretch4_nav_webapp.modes.navigation import NavigationMode


@pytest.fixture(autouse=True)
def _skip_robot_guardrail(monkeypatch):
    # These tests exercise launch-command construction, not the robot readiness
    # guardrail, so stub it out (it would otherwise shell out to the robot).
    monkeypatch.setattr(navigation_mod, "require_ready", lambda *_a, **_k: None)


class _NoopPM:
    def set_active_mode(self, *args, **kwargs):
        pass


def _ctx_with_map():
    maps_dir = Path(tempfile.mkdtemp())
    (maps_dir / "down").mkdir()
    for name in ("map.yaml", "map.pgm", "keepout.yaml", "keepout.pgm",
                 "speed.yaml", "speed.pgm"):
        (maps_dir / "down" / name).write_text("x")
    return ModeContext(
        maps_dir=maps_dir,
        process_manager=_NoopPM(),
        config=load_config(),
        extras={},
    )


def _no_empty_launch_args(cmd):
    return [tok for tok in cmd if tok.endswith(":=")]


def test_keepout_only_omits_empty_speed_mask():
    res = NavigationMode().start(
        _ctx_with_map(), map_name="down", use_keepout=True, use_speed=False
    )
    cmd = res["command"]
    assert _no_empty_launch_args(cmd) == []
    assert not any(tok.startswith("speed_mask:=") for tok in cmd)
    assert any(tok.startswith("keepout_mask:=") and tok.endswith("keepout.yaml") for tok in cmd)
    assert "enable_keepout:=true" in cmd and "enable_speed:=false" in cmd


def test_speed_only_omits_empty_keepout_mask():
    res = NavigationMode().start(
        _ctx_with_map(), map_name="down", use_keepout=False, use_speed=True
    )
    cmd = res["command"]
    assert _no_empty_launch_args(cmd) == []
    assert not any(tok.startswith("keepout_mask:=") for tok in cmd)
    assert any(tok.startswith("speed_mask:=") and tok.endswith("speed.yaml") for tok in cmd)


def test_both_filters_pass_both_masks():
    res = NavigationMode().start(
        _ctx_with_map(), map_name="down", use_keepout=True, use_speed=True
    )
    cmd = res["command"]
    assert _no_empty_launch_args(cmd) == []
    assert any(tok.startswith("keepout_mask:=") for tok in cmd)
    assert any(tok.startswith("speed_mask:=") for tok in cmd)
