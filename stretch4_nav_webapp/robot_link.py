"""Connecting the app to the robot, and disconnecting it.

Connected, the app owns the robot's ROS side: it runs its own rosbridge and
may launch mapping / navigation (each with its own stretch_driver). That
collides with anything else driving the robot.

Disconnected, the app starts and stops nothing on the robot: no rosbridge, no
mode launches, no robot status helper. Edit Map still works, since it only
reads and writes map files. Start that way with ``--disconnected``.

The switch is only allowed while no robot process of the app's is running
(see :meth:`RobotLink.blockers`), so nothing has to be torn down mid-run.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

from stretch4_nav_webapp.modes.base import shlex_split_launch

logger = logging.getLogger(__name__)

# Modes that launch robot processes. edit_map is a "soft" mode: files only.
ROBOT_MODES = ("mapping", "navigation")


def _pgid_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except OSError:
        return False


def stop_orphan_mode_launches() -> None:
    """Stop mode launches left behind by a previous backend that died. """
    patterns = ("launch stretch_nav2",)
    pgids: set[int] = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            cmdline = (
                (proc / "cmdline")
                .read_bytes()
                .replace(b"\0", b" ")
                .decode(errors="replace")
            )
            if "ros2" not in cmdline or not any(p in cmdline for p in patterns):
                continue
            stat_fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
            ppid = int(stat_fields[1])  # field 4 of /proc/pid/stat
            if ppid != 1:
                continue  # parent alive — owned by a running backend
            pgid = os.getpgid(int(proc.name))
        except (OSError, ValueError, IndexError):
            continue
        if pgid != os.getpgid(0):
            pgids.add(pgid)
    if not pgids:
        return

    logger.warning("Stopping orphaned mode launches: pgids=%s", sorted(pgids))
    for pgid in pgids:
        try:
            os.killpg(pgid, signal.SIGINT)
        except OSError:
            pass
    # The driver's clean shutdown (hardware disconnect) can take tens of
    # seconds; give ros2 launch room to escalate on its own before we do.
    deadline = time.time() + 30
    while time.time() < deadline and any(_pgid_alive(p) for p in pgids):
        time.sleep(0.5)
    for pgid in pgids:
        if _pgid_alive(pgid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass


def rosbridge_pids_on_port(port: int) -> list[int]:
    try:
        result = subprocess.run(
            ["ss", "-ltnp"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return []

    pids: set[int] = set()
    for line in result.stdout.splitlines():
        if f":{port} " not in line and f":{port}\t" not in line:
            continue
        for pid_text in re.findall(r"pid=(\d+)", line):
            pid = int(pid_text)
            try:
                cmdline = Path(f"/proc/{pid}/cmdline").read_text(encoding="utf-8")
            except OSError:
                continue
            if "rosbridge_websocket" in cmdline or "rosbridge_server" in cmdline:
                pids.add(pid)
    return sorted(pids)


def stop_existing_rosbridge(port: int) -> None:
    """Clear orphan rosbridge instances before starting the one owned by this CLI."""
    pids = rosbridge_pids_on_port(port)
    if not pids:
        return
    logger.warning("Stopping existing rosbridge on port %s: pids=%s", port, pids)
    pgids = set()
    for pid in pids:
        try:
            pgids.add(os.getpgid(pid))
        except OSError:
            pass
    for pgid in pgids:
        try:
            os.killpg(pgid, signal.SIGINT)
        except OSError:
            pass
    deadline = time.time() + 4
    while time.time() < deadline and rosbridge_pids_on_port(port):
        time.sleep(0.2)
    for pid in rosbridge_pids_on_port(port):
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except OSError:
            pass


class RobotLink:
    """Whether the app is connected to the robot, and the switch between the two."""

    def __init__(self, pm, config: dict, *, connected: bool, manage_rosbridge: bool = True) -> None:
        self.pm = pm
        self.config = config
        self.manage_rosbridge = manage_rosbridge
        self.connected = False
        self._lock = threading.Lock()
        if connected:
            self.connect()

    @classmethod
    def assume_connected(cls, pm, config: dict) -> "RobotLink":
        """Connected, without the takeover side effects (tests, embedding)."""
        link = cls(pm, config, connected=False, manage_rosbridge=False)
        link.connected = True
        return link

    def blockers(self) -> list[str]:
        """Why the switch can't be flipped right now (empty when it can)."""
        out = []
        if self.pm.active_mode in ROBOT_MODES:
            out.append(f"{self.pm.active_mode} is running")
        others = sorted(
            n for n, mp in self.pm.processes.items()
            if mp.running and n != "rosbridge" and not n.startswith("mode:")
        )
        if others:
            out.append("still running: " + ", ".join(others))
        return out

    def connect(self) -> None:
        with self._lock:
            if self.connected:
                return
            # Taking over: clear what a crashed earlier backend left driving the
            # robot, and any rosbridge holding our port.
            stop_orphan_mode_launches()
            if self.manage_rosbridge:
                port = int(self.config.get("rosbridge_port", 9090))
                stop_existing_rosbridge(port)
                cmd = shlex_split_launch(
                    self.config["launches"]["rosbridge"], rosbridge_port=str(port)
                )
                try:
                    self.pm.start("rosbridge", cmd)
                except Exception:
                    logger.exception("Failed to start rosbridge — UI may not get live topics")
            self.connected = True
            logger.info("Connected to the robot")

    def disconnect(self) -> None:
        from stretch4_nav_webapp.robot_status import stop_watching

        with self._lock:
            if not self.connected:
                return
            self.pm.stop("rosbridge")
            stop_watching()
            self.connected = False
            logger.info("Disconnected from the robot")

    def status(self) -> dict:
        blockers = self.blockers()
        return {
            "robot_connected": self.connected,
            "can_toggle_connection": not blockers,
            "connection_blockers": blockers,
        }
