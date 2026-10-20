"""Find the charging dock with stretch_nav2's discover_dock, while navigation runs.

The user parks the robot near the dock and localizes it on the map. A
discovery session then starts, beside the navigation stack:

- the head camera's center socket (navigation doesn't start any camera),
- ArUco detection on it, for the tags on the dock,
- discover_dock (through discover_dock_runner.py), which finds a dock-shaped
  cluster in the lidar, confirms it against those tags over several frames and
  saves its pose in the map frame.

"""

from __future__ import annotations

import logging
import shlex
import threading
import time
from pathlib import Path
from typing import Optional

from stretch4_nav_webapp.docks import read_first_dock
from stretch4_nav_webapp.paths import map_dir

logger = logging.getLogger(__name__)

PROCESS_PREFIX = "mode:navigation:discover"
_RUNNER = str(Path(__file__).with_name("discover_dock_runner.py"))

DEFAULT_LAUNCHES = [
    "ros2 launch stretch_core luxonis.launch.py use_left:=false use_right:=false use_center:=true",
    "ros2 launch stretch_tag_perception stretch_aruco.launch.py cameras:=center",
]


def session_db_path(maps_root: Path, name: str) -> Path:
    return map_dir(maps_root, name) / ".discover_dock_session.yaml"


def _runner_cmd(db: Path) -> list[str]:
    return [
        "bash",
        "-c",
        "source /opt/ros/jazzy/setup.bash 2>/dev/null || true; "
        "source ~/ament_ws/install/setup.bash 2>/dev/null || true; "
        f"exec python3 -u {shlex.quote(_RUNNER)} --db {shlex.quote(str(db))}",
    ]


def _log_tail(path: Optional[str], lines: int = 6) -> str:
    if not path:
        return ""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return "\n".join(text.strip().splitlines()[-lines:])


class DockDiscovery:
    """One discovery session at a time, owned by the app's ProcessManager."""

    WATCH_PERIOD_S = 1.0

    def __init__(self, pm, maps_root: Path, config: dict, restore_camera=None) -> None:
        self.pm = pm
        self.maps_root = maps_root
        self.launches = (config.get("dock_discovery") or {}).get("launches") or DEFAULT_LAUNCHES
        self.restore_camera = restore_camera
        self.map_name: Optional[str] = None
        self.started_at = 0.0
        self.error: Optional[str] = None
        self._camera_was_on = False
        self._session = 0  # bumped per start, so a stale watcher exits
        self._lock = threading.RLock()

    def _names(self) -> list[str]:
        return [n for n in self.pm.processes if n.startswith(PROCESS_PREFIX)]

    def running(self) -> bool:
        return bool(self._names())

    def start(self, map_name: str, *, camera_was_on: bool = False) -> dict:
        with self._lock:
            # A new session takes over the camera hand-back from an old one.
            camera_was_on = camera_was_on or self._camera_was_on
            self._camera_was_on = False
            for name in self._names():
                self.pm.stop(name)
            db = session_db_path(self.maps_root, map_name)
            db.unlink(missing_ok=True)
            for i, launch in enumerate(self.launches):
                self.pm.start(f"{PROCESS_PREFIX}:{i}", shlex.split(str(launch)))
            self.pm.start(f"{PROCESS_PREFIX}:node", _runner_cmd(db))
            self.map_name = map_name
            self.started_at = time.time()
            self.error = None
            self._camera_was_on = camera_was_on
            self._session += 1
            session = self._session
        logger.info("dock discovery started for map %s (db %s)", map_name, db)
        threading.Thread(
            target=self._watch, args=(session,), daemon=True, name="dock-discovery"
        ).start()
        return self.status()

    def stop(self) -> dict:
        """End the session (user's Stop / Discard), handing the camera back."""
        self._finish()
        return self.status()

    def _finish(self, *, restore: bool = True) -> None:
        with self._lock:
            self._session += 1
            for name in self._names():
                self.pm.stop(name)
            give_back = restore and self._camera_was_on
            self._camera_was_on = False
        if give_back and self.restore_camera:
            logger.info("dock discovery done, restarting the camera panel's camera")
            try:
                self.restore_camera()
            except Exception:  # noqa: BLE001 - the session is over either way
                logger.exception("could not restart the camera after dock discovery")

    def _watch(self, session: int) -> None:
        while True:
            time.sleep(self.WATCH_PERIOD_S)
            with self._lock:
                if session != self._session:
                    return  # stopped or replaced
                names = self._names()
                if not names or getattr(self.pm, "stopping_mode", False) \
                        or self.pm.active_mode != "navigation":
                    # Taken down from outside: navigation stopped. The camera
                    # stays off along with the rest of navigation.
                    self._session += 1
                    self._camera_was_on = False
                    return
                found = self.found()
                dead = [n for n in names if not self.pm.processes[n].running]
                if dead and not found:
                    # discover_dock and its helpers run until stopped, so one
                    # exiting on its own is a failure.
                    mp = self.pm.processes[dead[0]]
                    self.error = (
                        f"{' '.join(mp.command)[-120:]} exited.\n{_log_tail(mp.log_path)}"
                    ).strip()
            if found:
                logger.info("dock discovery found %s, stopping", found)
                self._finish()
                return
            if dead:
                logger.warning("dock discovery failed: %s", self.error)
                self._finish()
                return

    def found(self) -> Optional[dict]:
        if not self.map_name:
            return None
        return read_first_dock(session_db_path(self.maps_root, self.map_name))

    def status(self) -> dict:
        names = self._names()
        return {
            "running": bool(names),
            "map_name": self.map_name,
            "elapsed": round(time.time() - self.started_at, 1) if names else None,
            "found": self.found(),
            "error": self.error,
        }
