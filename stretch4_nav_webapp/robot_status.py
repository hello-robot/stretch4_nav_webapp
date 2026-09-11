"""Robot state (homed / stowed / dongle / battery / runstop) and robot actions.

Reads state through ``robot_client_helper.py`` (out-of-process ``RobotClient``,
a client of the always-on ``stretch_body_server`` — no ``stretch_driver``
needed). Used to gate Mapping/Navigation start and to drive the robot status
panel, the battery readout and the runstop warning.

State comes from a single long-lived ``watch`` helper that streams a snapshot
per second, not from per-request subprocesses: a fresh ``RobotClient`` costs
~1.5s of startup, which is far too slow to notice a runstop the moment someone
presses it. One-shot helper calls remain for the things the user *does*
(home / stow / runstop), where paying startup once is fine.

Home/stow are only ever run when the user presses a button (never automatically).
"""

from __future__ import annotations

import json
import logging
import math
import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

from stretch4_nav_webapp.process_manager import _load_robot_env, process_running

logger = logging.getLogger(__name__)

_HELPER = str(Path(__file__).with_name("robot_client_helper.py"))

# How close a joint has to sit to its stow target to count as stowed.
STOW_TOL_M = {"lift": 0.05}
STOW_TOL_DEFAULT_M = 0.03
STOW_TOL_RAD = 0.20           # ~11 degrees


def _angle_delta(a: float, b: float) -> float:
    """Shortest angular distance, so 3.14 and -3.14 are the same wrist pose."""
    return abs((a - b + math.pi) % (2 * math.pi) - math.pi)


def stow_offenders(check: dict | None) -> list[str] | None:
    """Names of the joints that are not at their stow target, or None if unknown. """
    if not check:
        return None
    out = []
    for joint, d in check.items():
        try:
            pos = float(d["pos"])
            target = float(d["target"])
        except (KeyError, TypeError, ValueError):
            return None
        if d.get("kind") == "angular":
            off = _angle_delta(pos, target) > STOW_TOL_RAD
        else:
            off = abs(pos - target) > STOW_TOL_M.get(joint, STOW_TOL_DEFAULT_M)
        if off:
            out.append(joint)
    return sorted(out)

# A reading older than this is not "the current state" any more — the UI says so
# rather than showing a battery percentage from a minute ago as if it were live.
FRESH_S = 6.0

# Below this the UI nudges people to plug in. The board runstops the robot on
# its own well before empty (RUNSTOP_LOW_SOC), so this is a warning, not a limit.
LOW_BATTERY_PCT = 20.0

_lock = threading.Lock()
_action: dict = {"name": None, "since": 0.0, "error": None}


def dongle_connected() -> bool:
    """The Stretch gamepad dongle enumerates as a joystick input device.

    Pure filesystem check — no ROS, no stretch_body — so it is cheap enough for
    the global status poll and works in every mode.
    """
    dev = Path("/dev/input")
    try:
        if any(dev.glob("js*")):
            return True
        byid = dev / "by-id"
        if byid.is_dir():
            return any(p.name.endswith("-joystick") for p in byid.iterdir())
    except OSError:
        pass
    return False


def _helper_env() -> dict:
    env = os.environ.copy()
    env.update(_load_robot_env())  # HELLO_FLEET_ID/PATH + RMW from robot conf
    local_bin = os.path.expanduser("~/.local/bin")
    env["PATH"] = f"{local_bin}:{env.get('PATH', '')}"  # ninja for editable rebuild
    return env


def _helper_bash(cmd: str) -> str:
    # -u so `watch` lines reach us as they are printed rather than in 4KB blocks.
    return (
        "source /opt/ros/jazzy/setup.bash 2>/dev/null || true; "
        "source ~/ament_ws/install/setup.bash 2>/dev/null || true; "
        f"exec python3 -u {shlex.quote(_HELPER)} {shlex.quote(cmd)}"
    )


def _run_helper(cmd: str, timeout: float) -> dict:
    proc = subprocess.run(
        ["bash", "-c", _helper_bash(cmd)],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_helper_env(),
    )
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith("RESULT "):
            return json.loads(line[len("RESULT "):])
    tail = (proc.stderr or proc.stdout or "").strip()[-300:]
    raise RuntimeError(tail or "no result from robot helper")


class _Watcher:
    """Supervises one long-lived ``helper watch`` subprocess and keeps its
    newest snapshot.

    Started lazily on the first status request so importing the backend (or
    running it off-robot) never spawns anything. If the helper dies — no robot,
    ``stretch_body_server`` restarted, USB glitch — it is restarted with a
    backoff, and until it produces a reading the snapshot simply reads stale,
    which the UI shows as "not answering" rather than as a fresh zero.
    """

    MIN_BACKOFF_S = 3.0
    MAX_BACKOFF_S = 60.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sample: dict | None = None
        self._sample_t = 0.0
        self._error: str | None = None
        self._started = False

    def ensure_started(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._supervise, daemon=True, name="robot-watch").start()

    def snapshot(self) -> tuple[dict | None, float, str | None]:
        """Return ``(sample, age_seconds, error)``. Sample may be stale or None."""
        with self._lock:
            sample = dict(self._sample) if self._sample else None
            age = (time.time() - self._sample_t) if self._sample else float("inf")
            return sample, age, self._error

    def note_sample(self, data: dict) -> None:
        with self._lock:
            if data.get("error") and not data.get("server_ok"):
                self._error = str(data["error"])
            else:
                self._sample = data
                self._sample_t = time.time()
                self._error = None

    def _supervise(self) -> None:
        backoff = self.MIN_BACKOFF_S
        while True:
            got_sample = False
            try:
                got_sample = self._run_once()
            except Exception as exc:  # noqa: BLE001
                with self._lock:
                    self._error = str(exc)
                logger.warning("robot watch helper failed to start: %s", exc)
            # A run that produced readings before dying was healthy — retry it
            # promptly. A run that never produced one is a robot that isn't
            # there, so back off instead of respawning python every 3 seconds.
            backoff = self.MIN_BACKOFF_S if got_sample else min(backoff * 2, self.MAX_BACKOFF_S)
            time.sleep(backoff)

    def _run_once(self) -> bool:
        proc = subprocess.Popen(
            ["bash", "-c", _helper_bash("watch")],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_helper_env(),
        )
        got_sample = False
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                if not line.startswith("RESULT "):
                    continue  # stretch4_body chatter — not ours
                try:
                    data = json.loads(line[len("RESULT "):])
                except json.JSONDecodeError:
                    continue
                self.note_sample(data)
                if data.get("server_ok"):
                    got_sample = True
        finally:
            try:
                proc.kill()
            except OSError:
                pass
            tail = ""
            try:
                _, tail = proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            if not got_sample:
                # The helper reports its own failures as a RESULT line, so an
                # error already recorded by note_sample beats the stderr tail.
                msg = (tail or "").strip()[-300:] or "exited without a reading"
                with self._lock:
                    if not self._error:
                        self._error = msg
                    msg = self._error
                logger.warning("robot watch helper: %s", msg)
        return got_sample


_watcher = _Watcher()

# The watch stream is the normal source. This one-shot is only for the first
# seconds after boot, before the stream has produced anything — rate-limited so
# a robot that never answers costs one subprocess a quarter-minute, not one per
# poll.
_SEED_MIN_INTERVAL_S = 15.0
_seed: dict = {"t": 0.0}


def _seed_snapshot() -> dict | None:
    with _lock:
        # A running home/stow means a RobotClient routine is already in flight;
        # don't add a second client just to fill a gap the stream will close.
        if _action["name"] or (time.time() - _seed["t"]) < _SEED_MIN_INTERVAL_S:
            return None
        _seed["t"] = time.time()
    try:
        return _run_helper("readiness", timeout=25)
    except Exception as exc:  # noqa: BLE001
        logger.warning("robot readiness helper failed: %s", exc)
        return {"server_ok": False, "error": str(exc)}


def get_readiness(max_age: float = FRESH_S) -> dict:
    """Return the current robot snapshot: readiness, battery and runstop."""
    _watcher.ensure_started()
    with _lock:
        action = _action["name"]
        action_err = _action["error"]

    base, age, watch_error = _watcher.snapshot()
    if base is None or age > max_age:
        seeded = _seed_snapshot()
        if seeded is not None:
            base, age, watch_error = seeded, 0.0, seeded.get("error")
            if seeded.get("server_ok"):
                _watcher.note_sample(seeded)

    base = base or {}
    stale = age > max_age
    server_ok = bool(base.get("server_ok")) and not stale
    arm_pos = base.get("arm_pos")
    homed = base.get("homed") if server_ok else None
    offenders = stow_offenders(base.get("stow_check")) if homed is True else None
    stowed = (not offenders) if offenders is not None else None
    soc = base.get("battery_soc") if server_ok else None
    return {
        "server_ok": server_ok,
        "homed": homed,
        "stowed": stowed,
        "stow_offenders": offenders,
        "arm_pos": arm_pos,
        "dongle_connected": dongle_connected(),
        "gamepad_running": process_running("stretch_gamepad_teleop"),
        "runstop_engaged": base.get("runstop_engaged") if server_ok else None,
        "runstop_cause": base.get("runstop_cause") if server_ok else None,
        "battery_soc": soc,
        "battery_voltage": base.get("battery_voltage") if server_ok else None,
        "charging": base.get("charging") if server_ok else None,
        "plugged_in": base.get("plugged_in") if server_ok else None,
        "low_battery": (
            bool(base.get("low_battery_alert")) or soc <= LOW_BATTERY_PCT
            if server_ok and soc is not None
            else None
        ),
        "reading_age": None if age == float("inf") else round(age, 1),
        "busy": action,
        "action_error": action_err,
        "error": base.get("error") or (watch_error if not server_ok else None),
    }


def set_runstop(engaged: bool) -> dict:
    """Engage or release the runstop. Never gated on anything — a stop button
    that can be busy is not a stop button.

    Returns the state the board reported straight after, so the UI can tell the
    difference between "released" and "you released it in software but the
    physical button is still held in".
    """
    res = _run_helper("runstop_on" if engaged else "runstop_off", timeout=30)
    if res.get("error"):
        raise RuntimeError(res["error"])
    if res.get("server_ok"):
        _watcher.note_sample(res)
    return {
        "ok": True,
        "requested": engaged,
        "runstop_engaged": res.get("runstop_engaged"),
        "runstop_cause": res.get("runstop_cause"),
    }


def _run_action_async(name: str) -> None:
    with _lock:
        if _action["name"]:
            raise RuntimeError(f"{_action['name']} already in progress")
        _action["name"] = name
        _action["since"] = time.time()
        _action["error"] = None

    def worker() -> None:
        err = None
        try:
            # Must exceed the routine timeouts in robot_client_helper (home 120s,
            # stow 90s) plus RobotClient startup overhead, or we'd kill the
            # subprocess mid-motion.
            res = _run_helper(name, timeout=180)
            err = res.get("error")
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
        if err:
            logger.warning("robot %s failed: %s", name, err)
        with _lock:
            _action["name"] = None
            _action["error"] = err
        # No cache to invalidate: the watch stream is already reporting the new
        # joint positions, live, while the routine runs.

    threading.Thread(target=worker, daemon=True, name=f"robot-{name}").start()


def start_home() -> dict:
    """Kick off homing in the background (user-initiated). Poll readiness for done."""
    _run_action_async("home")
    return {"ok": True, "started": True, "action": "home"}


def start_stow() -> dict:
    """Kick off stow in the background (user-initiated).
    """
    r = get_readiness()
    if r.get("homed") is not True:
        raise ValueError(
            "Home the robot before stowing"
        )
    _run_action_async("stow")
    return {"ok": True, "started": True, "action": "stow"}


def require_ready(mode_id: str) -> None:
    """Raise ValueError if the robot isn't ready to start ``mode_id``.

    Mapping needs homed + stowed + dongle (people drive it manually). Navigation
    needs homed. Raised ValueErrors surface to the client as HTTP 400.
    """
    r = get_readiness()
    if not r["server_ok"]:
        raise ValueError(
            r.get("error")
            or "Robot not reachable — is stretch_body_server running?"
        )
    missing = []
    if r["homed"] is not True:
        missing.append("robot is not homed")
    if mode_id == "mapping":
        if r["stowed"] is not True:
            out = r.get("stow_offenders")
            missing.append(
                "robot is not stowed (" + ", ".join(out) + ")" if out else "robot is not stowed"
            )
        if not r["dongle_connected"]:
            missing.append("gamepad dongle is not connected")
    if missing:
        raise ValueError(f"Robot not ready for {mode_id}: " + "; ".join(missing) + ".")
