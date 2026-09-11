"""The status stream feeding the battery readout and the runstop warning.

"""

import json
import time

import pytest

from stretch4_nav_webapp import robot_status as rs


@pytest.fixture(autouse=True)
def _isolated_watcher(monkeypatch):
    """Give every test its own watcher and no real subprocesses."""
    monkeypatch.setattr(rs, "_watcher", rs._Watcher())
    monkeypatch.setattr(rs, "dongle_connected", lambda: False)
    monkeypatch.setattr(rs, "process_running", lambda _name: False)
    # Never let a test fall through to a real RobotClient one-shot.
    monkeypatch.setattr(rs, "_seed_snapshot", lambda: None)
    yield


# The stow pose the helper reads out of stretch_params for this robot's tool,
# with every joint sitting on its target.
STOWED_CHECK = {
    "arm": {"pos": 0.0, "target": 0.0, "kind": "linear"},
    "lift": {"pos": 0.15, "target": 0.15, "kind": "linear"},
    "wrist_pitch": {"pos": 0.0, "target": 0.0, "kind": "angular"},
    "wrist_roll": {"pos": 0.0, "target": 0.0, "kind": "angular"},
    "wrist_yaw": {"pos": 3.14, "target": 3.14, "kind": "angular"},
}

SAMPLE = {
    "server_ok": True,
    "homed": True,
    "arm_pos": 0.005,
    "stow_check": STOWED_CHECK,
    "runstop_engaged": False,
    "runstop_cause": None,
    "battery_soc": 96.0,
    "charging": True,
    "plugged_in": True,
    "low_battery_alert": False,
}


def test_stream_lines_become_the_snapshot(monkeypatch):
    """A `watch` run parses RESULT lines and ignores stretch4_body's chatter."""
    lines = [
        "loading params...",  # not ours
        "RESULT " + json.dumps(SAMPLE),
        "RESULT not-json",  # must not kill the reader
        "RESULT " + json.dumps({**SAMPLE, "battery_soc": 91.0}),
    ]
    script = "; ".join(f"echo {json.dumps(line)}" for line in lines)
    monkeypatch.setattr(rs, "_helper_bash", lambda _cmd: script)

    assert rs._watcher._run_once() is True
    r = rs.get_readiness()
    assert r["server_ok"] is True
    assert r["battery_soc"] == 91.0  # newest line wins
    assert r["charging"] is True
    assert r["stowed"] is True  # every joint on its stow target


def test_reading_that_stops_arriving_reads_as_no_link():
    """Stale is reported as "not answering", never as fresh state.

    Showing a minute-old battery level as current is worse than showing
    nothing: it is the reading someone would trust to decide the robot can
    make it across the building.
    """
    rs._watcher.note_sample(SAMPLE)
    rs._watcher._sample_t = time.time() - (rs.FRESH_S + 10)

    r = rs.get_readiness()
    assert r["server_ok"] is False
    assert r["battery_soc"] is None
    assert r["runstop_engaged"] is None
    assert r["reading_age"] > rs.FRESH_S


def test_runstop_state_and_cause_surface():
    rs._watcher.note_sample(
        {**SAMPLE, "runstop_engaged": True, "runstop_cause": "RUNSTOP_BUTTON"}
    )
    r = rs.get_readiness()
    assert r["runstop_engaged"] is True
    assert r["runstop_cause"] == "RUNSTOP_BUTTON"


def test_low_battery_flag_tracks_both_sources():
    """The board's own alert and the UI's threshold both count."""
    rs._watcher.note_sample({**SAMPLE, "battery_soc": 55.0})
    assert rs.get_readiness()["low_battery"] is False

    rs._watcher.note_sample({**SAMPLE, "battery_soc": 12.0})
    assert rs.get_readiness()["low_battery"] is True

    rs._watcher.note_sample({**SAMPLE, "battery_soc": 55.0, "low_battery_alert": True})
    assert rs.get_readiness()["low_battery"] is True


def test_runstop_does_not_block_mode_start():
    """Runstop is a warning, not a gate — starting a mode stays the user's call."""
    rs._watcher.note_sample(
        {**SAMPLE, "runstop_engaged": True, "runstop_cause": "RUNSTOP_BUTTON"}
    )
    rs.require_ready("navigation")  # homed; runstop on is not a blocker


def test_set_runstop_sends_the_right_command(monkeypatch):
    seen = []
    monkeypatch.setattr(
        rs,
        "_run_helper",
        lambda cmd, timeout: seen.append(cmd)
        or {"ok": True, "server_ok": True, "runstop_engaged": cmd == "runstop_on"},
    )
    assert rs.set_runstop(True)["runstop_engaged"] is True
    assert rs.set_runstop(False)["runstop_engaged"] is False
    assert seen == ["runstop_on", "runstop_off"]


def test_set_runstop_raises_on_helper_error(monkeypatch):
    monkeypatch.setattr(rs, "_run_helper", lambda cmd, timeout: {"error": "no server"})
    with pytest.raises(RuntimeError, match="no server"):
        rs.set_runstop(True)


def test_runstop_endpoint_wiring(monkeypatch):
    import tempfile
    from pathlib import Path

    from fastapi.testclient import TestClient

    from stretch4_nav_webapp import app as app_mod

    calls = []
    monkeypatch.setattr(
        rs, "set_runstop", lambda engaged: calls.append(engaged) or {"ok": True}
    )
    client = TestClient(app_mod.create_app(maps_dir=Path(tempfile.mkdtemp())))

    assert client.post("/api/robot/runstop", json={"engaged": True}).status_code == 200
    assert client.post("/api/robot/runstop", json={"engaged": False}).status_code == 200
    assert calls == [True, False]
    # No default: a stop request that lost its field must fail loudly, not
    # quietly pick a direction.
    assert client.post("/api/robot/runstop", json={}).status_code == 422


# --- stowed: compare against the tool's stow params ----


def test_a_retracted_arm_alone_is_not_stowed():
    rs._watcher.note_sample(
        {
            **SAMPLE,
            "arm_pos": 0.0998,  # under the old 0.10 m threshold
            "stow_check": {
                **STOWED_CHECK,
                "arm": {"pos": 0.0998, "target": 0.0, "kind": "linear"},
                "lift": {"pos": 0.50, "target": 0.15, "kind": "linear"},
                "wrist_pitch": {"pos": 1.10, "target": 0.0, "kind": "angular"},
                "wrist_yaw": {"pos": 0.0, "target": 3.14, "kind": "angular"},
            },
        }
    )
    r = rs.get_readiness()
    assert r["stowed"] is False
    assert r["stow_offenders"] == ["arm", "lift", "wrist_pitch", "wrist_yaw"]


def test_wrist_angle_wraps():
    """-pi and +pi are the same wrist pose, so stow must not call one of them out."""
    rs._watcher.note_sample(
        {
            **SAMPLE,
            "stow_check": {
                **STOWED_CHECK,
                "wrist_yaw": {"pos": -3.1414, "target": 3.1414, "kind": "angular"},
            },
        }
    )
    assert rs.get_readiness()["stowed"] is True


def test_small_settling_error_still_counts_as_stowed():
    """Lift sag and wrist backlash are not "not stowed"."""
    rs._watcher.note_sample(
        {
            **SAMPLE,
            "stow_check": {
                **STOWED_CHECK,
                "lift": {"pos": 0.13, "target": 0.15, "kind": "linear"},
                "wrist_pitch": {"pos": 0.1, "target": 0.0, "kind": "angular"},
            },
        }
    )
    assert rs.get_readiness()["stowed"] is True


def test_stowed_is_unknown_until_homed():
    """Un-homed joint positions are offsets from an arbitrary zero.

    Reporting False there would send someone to press Stow, which is exactly
    the move that must not happen before homing.
    """
    rs._watcher.note_sample({**SAMPLE, "homed": False})
    r = rs.get_readiness()
    assert r["homed"] is False
    assert r["stowed"] is None
    assert r["stow_offenders"] is None


def test_stowed_is_unknown_without_stow_params():
    """No params for this tool means unknown — never a guess from arm extension."""
    rs._watcher.note_sample({**SAMPLE, "stow_check": None})
    assert rs.get_readiness()["stowed"] is None


def test_mapping_start_names_the_joints_that_are_out():
    rs._watcher.note_sample(
        {
            **SAMPLE,
            "stow_check": {
                **STOWED_CHECK,
                "wrist_yaw": {"pos": 0.0, "target": 3.14, "kind": "angular"},
            },
        }
    )
    with pytest.raises(ValueError, match="wrist_yaw"):
        rs.require_ready("mapping")


# --- stow action: homing is a precondition ----------------------------------


def test_stow_is_refused_until_homed(monkeypatch):
    """A stow against un-homed zeros can drive the arm into a hard stop."""
    ran = []
    monkeypatch.setattr(rs, "_run_action_async", lambda name: ran.append(name))
    rs._watcher.note_sample({**SAMPLE, "homed": False})

    with pytest.raises(ValueError, match="Home the robot before stowing"):
        rs.start_stow()
    assert ran == []


def test_stow_runs_once_homed(monkeypatch):
    ran = []
    monkeypatch.setattr(rs, "_run_action_async", lambda name: ran.append(name))
    rs._watcher.note_sample(SAMPLE)

    assert rs.start_stow()["started"] is True
    assert ran == ["stow"]


def test_stow_endpoint_reports_the_refusal_as_400(monkeypatch):
    import tempfile
    from pathlib import Path

    from fastapi.testclient import TestClient

    from stretch4_nav_webapp import app as app_mod

    monkeypatch.setattr(rs, "_run_action_async", lambda name: None)
    rs._watcher.note_sample({**SAMPLE, "homed": False})
    client = TestClient(app_mod.create_app(maps_dir=Path(tempfile.mkdtemp())))

    resp = client.post("/api/robot/stow", json={})
    assert resp.status_code == 400
    assert "Home the robot" in resp.json()["detail"]
