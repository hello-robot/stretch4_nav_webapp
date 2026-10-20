"""Find dock: the discovery session's processes, its result, and the camera hand-back."""

import tempfile
import time
from pathlib import Path

import pytest
import yaml

from stretch4_nav_webapp.dock_discovery import DockDiscovery, session_db_path


class _Proc:
    def __init__(self, command, running=True):
        self.command = command
        self.running = running
        self.log_path = None


class _FakePM:
    def __init__(self):
        self.processes = {}
        self.active_mode = "navigation"
        self.stopping_mode = False

    def start(self, name, cmd):
        self.processes[name] = _Proc(cmd)

    def stop(self, name):
        self.processes.pop(name, None)


@pytest.fixture(autouse=True)
def _fast_watch(monkeypatch):
    monkeypatch.setattr(DockDiscovery, "WATCH_PERIOD_S", 0.02)


def _setup():
    root = Path(tempfile.mkdtemp())
    (root / "down").mkdir()
    pm = _FakePM()
    restored = []
    disc = DockDiscovery(pm, root, {}, restore_camera=lambda: restored.append(True))
    return root, pm, disc, restored


def _write_found(root):
    session_db_path(root, "down").write_text(yaml.safe_dump({
        "version": "1.0",
        "docks": {"dock_1": {"pose": {"position": [1.0, 2.0, 0.1],
                                      "orientation": [0.0, 0.0, 0.0, 1.0]}}},
    }))


def _wait_until(cond, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_start_runs_camera_aruco_and_discover_dock():
    root, pm, disc, _ = _setup()
    status = disc.start("down")
    assert status["running"] and status["found"] is None
    assert len(pm.processes) == 3
    node = pm.processes["mode:navigation:discover:node"].command
    assert "discover_dock_runner.py" in node[-1]
    assert str(session_db_path(root, "down")) in node[-1]
    disc.stop()


def test_start_clears_the_previous_session():
    root, pm, disc, _ = _setup()
    _write_found(root)
    disc.start("down")
    assert disc.status()["found"] is None
    disc.stop()


def test_found_dock_ends_the_session_and_restores_the_camera():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=True)
    _write_found(root)
    assert _wait_until(lambda: pm.processes == {})
    assert restored == [True]
    status = disc.status()
    assert status["found"]["x"] == 1.0 and not status["running"]


def test_camera_not_restarted_if_it_was_off():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=False)
    _write_found(root)
    assert _wait_until(lambda: pm.processes == {})
    assert restored == []


def test_a_process_dying_ends_the_session_and_restores_the_camera():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=True)
    pm.processes["mode:navigation:discover:node"].running = False
    assert _wait_until(lambda: pm.processes == {})
    assert restored == [True]
    assert "exited" in disc.status()["error"]


def test_user_stop_restores_the_camera_once():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=True)
    disc.stop()
    disc.stop()
    assert pm.processes == {} and restored == [True]


def test_look_again_keeps_the_camera_to_restore():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=True)
    disc.start("down")  # Look again: the panel camera is already off by now
    assert restored == []
    disc.stop()
    assert restored == [True]


def test_navigation_stopping_leaves_the_camera_off():
    root, pm, disc, restored = _setup()
    disc.start("down", camera_was_on=True)
    pm.stopping_mode = True
    pm.processes["mode:navigation:discover:0"].running = False  # mid-shutdown
    time.sleep(0.1)
    pm.processes.clear()
    pm.stopping_mode = False
    pm.active_mode = None
    time.sleep(0.1)
    assert restored == []
    assert disc.status()["error"] is None
