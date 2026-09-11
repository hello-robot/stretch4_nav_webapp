#!/usr/bin/env python3
"""Out-of-process helper that talks to the running ``stretch_body_server`` via
stretch4_body's ``RobotClient`` and prints a one-line JSON result.

Why a subprocess and not an in-process import: ``stretch4_body`` is an editable
install that rebuilds itself on import (needs ninja + the full Stretch
environment, ``HELLO_FLEET_ID`` etc.). Importing it into the long-lived FastAPI
process would make the backend fragile and hard to run anywhere. Isolating it in
a short-lived subprocess keeps the backend importable without a robot and lets
the OS tear down the client cleanly each call.

``RobotClient`` is a *client* of the always-on ``stretch_body_server`` (shared
hardware access), so it works with or without ``stretch_driver`` running and
never fights the driver for the USB.

One-shot commands print a single ``RESULT <json>`` line and exit. ``watch`` is
the exception: it holds one client open and prints a fresh ``RESULT`` line every
second, so the backend can show live battery / runstop without paying ~1.5s of
client startup on every poll.

Usage: ``robot_client_helper.py {watch|readiness|home|stow|runstop_on|runstop_off}``
"""

import json
import sys
import time


def _with_client(fn):
    from stretch4_body.robot.robot_client import RobotClient

    rc = RobotClient()
    if not rc.startup():
        raise RuntimeError(
            "RobotClient.startup() failed (is stretch_body_server running?)"
        )
    try:
        return fn(rc)
    finally:
        try:
            rc.stop()
        except Exception:
            pass


def _arm_pos(rc):
    arm = getattr(rc, "arm", None)
    if arm is None:
        return None
    pos = arm.status.get("pos")
    return float(pos) if pos is not None else None

STOW_IGNORED_JOINTS = ("stretch_gripper", "parallel_gripper")


def _stow_check(rc):
    """Per-joint ``{pos, target, kind}`` for the tool's stow pose, or None.

    The stow pose is not a constant: every tool in stretch_params declares its
    own under ``robot_params[<tool>]['stow']``.

    ``kind`` travels with each joint because the caller compares them: linear
    joints are metres, angular ones radians that wrap at +-pi.
    """
    try:
        tool = rc.robot_params["robot"]["tool"]
        cfg = rc.robot_params[tool]["stow"]
    except (AttributeError, KeyError, TypeError):
        return None
    if not isinstance(cfg, dict):
        return None

    def entry(pos, target, kind):
        if pos is None or not isinstance(target, (int, float)):
            return None
        return {"pos": float(pos), "target": float(target), "kind": kind}

    out = {}
    eoa = getattr(rc, "end_of_arm", None)
    for joint, target in cfg.items():
        if joint in STOW_IGNORED_JOINTS or joint.endswith("_prestow"):
            continue
        sub = getattr(rc, joint, None)
        if sub is not None and hasattr(sub, "status"):  # arm / lift
            item = entry(sub.status.get("pos"), target, "linear")
        elif eoa is not None and joint in getattr(eoa, "joints", ()):
            item = entry(eoa.status.get(joint, {}).get("pos"), target, "angular")
        else:
            item = None  # joint the params name but this robot does not have
        if item is not None:
            out[joint] = item
    return out or None


def _snapshot(rc):
    """One pulled reading of everything the UI shows. Assumes pull_status() ran.

    Power fields come from the PowerPeriph board: ``battery_soc`` is a percent,
    ``runstop_event`` is True while motion is inhibited, and ``runstop_cause``
    names *why* ("RUNSTOP_BUTTON", "RUNSTOP_PYTHON_CMD", "RUNSTOP_LOW_SOC",
    "RUNSTOP_HIGH_CURRENT", "RUNSTOP_HIGH_CURRENT_EOA") or None. The cause is
    what lets the UI tell someone how to get moving again.
    """
    lift = getattr(rc, "lift", None)
    lift_pos = None
    if lift is not None and lift.status.get("pos") is not None:
        lift_pos = float(lift.status.get("pos"))

    power = getattr(rc, "power_periph", None)
    p = dict(power.status) if power is not None else {}

    def num(key):
        v = p.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    return {
        "server_ok": True,
        "homed": bool(rc.is_homed()),
        "arm_pos": _arm_pos(rc),
        "lift_pos": lift_pos,
        "stow_check": _stow_check(rc),
        "runstop_engaged": bool(p.get("runstop_event")) if p else None,
        "runstop_cause": p.get("runstop_cause"),
        "battery_soc": num("battery_soc"),
        "battery_voltage": num("voltage"),
        "charging": bool(p.get("charger_is_charging")) if p else None,
        "plugged_in": bool(p.get("adapter_voltage_present")) if p else None,
        "low_battery_alert": bool(p.get("low_soc_alert")) if p else None,
    }


def cmd_readiness():
    def read(rc):
        rc.pull_status()
        return _snapshot(rc)

    return _with_client(read)


WATCH_PERIOD_S = 1.0
# A few bad pulls in a row means the link is gone, not a hiccup — exit and let
# the backend's supervisor restart us with a fresh client rather than sit here
# republishing a stale reading forever.
WATCH_MAX_CONSECUTIVE_ERRORS = 3


def cmd_watch():
    """Hold one client open and stream a snapshot per second until killed."""

    def loop(rc):
        errors = 0
        while True:
            try:
                rc.pull_status()
                _emit(_snapshot(rc))
                errors = 0
            except Exception as exc:  # noqa: BLE001
                errors += 1
                _emit({"server_ok": False, "error": str(exc)})
                if errors >= WATCH_MAX_CONSECUTIVE_ERRORS:
                    raise
            time.sleep(WATCH_PERIOD_S)

    return _with_client(loop)


# Runstop is the safety stop: trigger inhibits all motion, clear releases it.
# Both are queued commands, so they only reach the board on push_command() —
# same sequence as stretch4_body's own stretch_runstop tool.
def _set_runstop(engaged: bool):
    def do(rc):
        if engaged:
            rc.power_periph.trigger_runstop()
        else:
            rc.power_periph.clear_runstop()
        rc.push_command()
        # The board needs a beat to apply it and report back; without the wait
        # we would echo the pre-command state and the UI would look stuck.
        time.sleep(0.6)
        rc.pull_status()
        snap = _snapshot(rc)
        return {"ok": True, "requested": engaged, **snap}

    return _with_client(do)


def cmd_runstop_on():
    return _set_runstop(True)


def cmd_runstop_off():
    return _set_runstop(False)


# Routines move joints sequentially and take much longer than the library's
# short defaults (stow ~40-60s, homing longer). The timeout must exceed the real
# duration: if wait_on_completion times out we disconnect (_with_client -> stop())
# and abort the routine mid-motion — which is exactly why stow "did nothing" at
# the 30s default (it aborted before the arm retracted).
HOME_TIMEOUT_S = 120
STOW_TIMEOUT_S = 90


def cmd_home():
    def do(rc):
        rc.home(wait_on_completion=True, timeout=HOME_TIMEOUT_S)
        rc.pull_status()
        return {"ok": True, "homed": bool(rc.is_homed())}

    return _with_client(do)


def cmd_stow():
    def do(rc):
        # Home before stow.
        if not rc.is_homed():
            raise RuntimeError("robot is not homed; home it before stowing")
        rc.stow(wait_on_completion=True, timeout=STOW_TIMEOUT_S)
        rc.pull_status()
        return {"ok": True, "arm_pos": _arm_pos(rc), "stow_check": _stow_check(rc)}

    return _with_client(do)


def _emit(payload):
    # flush: `watch` is read line-by-line by a live reader, so a buffered line
    # is a reading nobody sees.
    print("RESULT " + json.dumps(payload), flush=True)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "readiness"
    handlers = {
        "readiness": cmd_readiness,
        "watch": cmd_watch,
        "home": cmd_home,
        "stow": cmd_stow,
        "runstop_on": cmd_runstop_on,
        "runstop_off": cmd_runstop_off,
    }
    if cmd not in handlers:
        _emit({"error": f"unknown command: {cmd}"})
        return 2
    try:
        result = handlers[cmd]()
        if result is not None:  # `watch` emits as it goes and never returns
            _emit(result)
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        _emit({"error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
