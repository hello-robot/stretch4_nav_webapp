"""The readiness guardrail must block by default and be skippable on request.

The preflight screen *offers* Home/Stow rather than forcing them, so the UI needs
an escape hatch ("Start anyway") that reaches the backend as
``skip_readiness=True``. Without the flag the guardrail must still fire —
otherwise the default path silently loses its safety check.
"""

import tempfile
from pathlib import Path

import pytest

from stretch4_nav_webapp.app import ModeStartBody, load_config
from stretch4_nav_webapp.modes import mapping as mapping_mod
from stretch4_nav_webapp.modes import navigation as navigation_mod
from stretch4_nav_webapp.modes.base import ModeContext
from stretch4_nav_webapp.modes.mapping import MappingMode
from stretch4_nav_webapp.modes.navigation import NavigationMode


class _RecordingPM:
    def __init__(self):
        self.started = []
        self.active_mode = None

    def set_active_mode(self, mode_id, cmd):
        self.active_mode = mode_id
        self.started.append((mode_id, cmd))

    def start(self, name, cmd):
        self.started.append((name, cmd))

    def stop_mode(self):
        pass


def _ctx():
    maps_dir = Path(tempfile.mkdtemp())
    (maps_dir / "down").mkdir()
    for name in ("map.yaml", "map.pgm"):
        (maps_dir / "down" / name).write_text("x")
    return ModeContext(
        maps_dir=maps_dir,
        process_manager=_RecordingPM(),
        config=load_config(),
        extras={},
    )


@pytest.fixture
def blocked(monkeypatch):
    """Make require_ready() behave as it does on an un-homed robot."""

    def _raise(mode_id):
        raise ValueError(f"Robot not ready for {mode_id}: robot is not homed.")

    monkeypatch.setattr(navigation_mod, "require_ready", _raise)
    monkeypatch.setattr(mapping_mod, "require_ready", _raise)
    # Mapping otherwise shells out to look for helper binaries / processes.
    monkeypatch.setattr(mapping_mod, "_stretch_body_server_cmd", lambda: None)
    monkeypatch.setattr(mapping_mod, "_gamepad_cmd", lambda: None)


def test_navigation_blocks_when_not_ready(blocked):
    with pytest.raises(ValueError, match="not homed"):
        NavigationMode().start(_ctx(), map_name="down")


def test_navigation_starts_when_readiness_skipped(blocked):
    res = NavigationMode().start(_ctx(), map_name="down", skip_readiness=True)
    assert res["ok"] is True
    assert any(tok.startswith("map:=") for tok in res["command"])


def test_mapping_blocks_when_not_ready(blocked):
    with pytest.raises(ValueError, match="not homed"):
        MappingMode().start(_ctx())


def test_mapping_starts_when_readiness_skipped(blocked):
    ctx = _ctx()
    res = MappingMode().start(ctx, skip_readiness=True)
    assert res["ok"] is True
    assert ctx.process_manager.active_mode == "mapping"


def test_skip_readiness_defaults_to_false():
    # A body without the field (every existing client) keeps the guardrail.
    assert ModeStartBody().skip_readiness is False
    assert ModeStartBody(map_name="down").skip_readiness is False


def test_start_mode_forwards_skip_readiness(monkeypatch):
    """The API layer must marshal the flag.

    ``start_mode`` builds its kwargs field by field rather than splatting the
    model, so a missing line there would silently re-arm the guardrail for the
    UI's "Start anyway" button while every unit test below still passed.
    """
    from fastapi.testclient import TestClient

    from stretch4_nav_webapp import app as app_mod

    seen: dict = {}

    class _Mode:
        id = "navigation"

        def start(self, ctx, **kwargs):
            seen.clear()
            seen.update(kwargs)
            return {"ok": True}

    monkeypatch.setattr(app_mod, "get_mode", lambda mode_id: _Mode())
    client = TestClient(app_mod.create_app(maps_dir=Path(tempfile.mkdtemp())))

    client.post("/api/modes/navigation/start", json={"map_name": "down", "skip_readiness": True})
    assert seen["skip_readiness"] is True

    client.post("/api/modes/navigation/start", json={"map_name": "down"})
    assert seen["skip_readiness"] is False
