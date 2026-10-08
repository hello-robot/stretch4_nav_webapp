"""Connecting / disconnecting the app from the robot, only between runs."""

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from stretch4_nav_webapp import robot_link as robot_link_mod
from stretch4_nav_webapp.app import create_app, load_config
from stretch4_nav_webapp.process_manager import ProcessManager
from stretch4_nav_webapp.robot_link import RobotLink


class _Proc:
    running = True


@pytest.fixture(autouse=True)
def _no_takeover(monkeypatch):
    # connect() would scan /proc and kill orphaned launches / rosbridge.
    monkeypatch.setattr(robot_link_mod, "stop_orphan_mode_launches", lambda: None)
    monkeypatch.setattr(robot_link_mod, "stop_existing_rosbridge", lambda port: None)


def _client(connected):
    pm = ProcessManager()
    pm.start = lambda name, cmd, **kw: pm.processes.__setitem__(name, _Proc())
    pm.stop = lambda name, **kw: pm.processes.pop(name, None)
    link = RobotLink(pm, load_config(), connected=connected)
    return TestClient(create_app(maps_dir=Path(tempfile.mkdtemp()), process_manager=pm, robot_link=link)), pm


def test_start_disconnected_runs_nothing():
    client, pm = _client(connected=False)
    assert pm.processes == {}
    status = client.get("/api/status").json()
    assert status["robot_connected"] is False and status["can_toggle_connection"] is True
    assert client.get("/api/robot/readiness").json()["disconnected"] is True


def test_robot_endpoints_refuse_while_disconnected():
    client, _ = _client(connected=False)
    assert client.post("/api/modes/navigation/start", json={"map_name": "x"}).status_code == 409
    assert client.post("/api/modes/mapping/start", json={}).status_code == 409
    assert client.post("/api/robot/home").status_code == 409
    assert client.post("/api/navigation/goal", json={"x": 0, "y": 0}).status_code == 409
    # Map editing needs no robot.
    assert client.post("/api/modes/edit_map/start", json={}).status_code == 200
    assert client.get("/api/maps").status_code == 200


def test_connect_starts_rosbridge_and_disconnect_stops_it():
    client, pm = _client(connected=False)
    assert client.post("/api/robot/connection", json={"connected": True}).json()["robot_connected"]
    assert "rosbridge" in pm.processes
    assert not client.post("/api/robot/connection", json={"connected": False}).json()["robot_connected"]
    assert "rosbridge" not in pm.processes


def test_cannot_toggle_mid_run():
    client, pm = _client(connected=True)
    pm.active_mode = "navigation"
    status = client.get("/api/robot/connection").json()
    assert status["can_toggle_connection"] is False
    assert "navigation is running" in status["connection_blockers"]
    assert client.post("/api/robot/connection", json={"connected": False}).status_code == 409
    # Asking for the state it is already in is fine.
    assert client.post("/api/robot/connection", json={"connected": True}).status_code == 200


def test_edit_map_does_not_block_the_toggle():
    client, pm = _client(connected=True)
    pm.active_mode = "edit_map"
    assert client.post("/api/robot/connection", json={"connected": False}).status_code == 200


def test_other_robot_processes_block_the_toggle():
    client, pm = _client(connected=True)
    pm.processes["gamepad"] = _Proc()
    assert client.post("/api/robot/connection", json={"connected": False}).status_code == 409
