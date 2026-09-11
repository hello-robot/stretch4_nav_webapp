"""Subprocess manager for rosbridge and mode launches."""

from __future__ import annotations

import logging
import os
import re
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


def _load_robot_env() -> dict[str, str]:
    """Return Stretch robot environment defaults needed by launch files."""
    env: dict[str, str] = {}
    conf = "/etc/hello-robot/hello-robot.conf"
    try:
        with open(conf, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key:
                    env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    env.setdefault("HELLO_FLEET_PATH", os.path.expanduser("~/stretch_user"))
    if os.path.exists("/opt/ros/jazzy/lib/librmw_zenoh_cpp.so"):
        env.setdefault("RMW_IMPLEMENTATION", "rmw_zenoh_cpp")
    return env


def process_running(basename: str) -> bool:
    """True if any process on this machine runs an executable named ``basename``."""
    try:
        result = subprocess.run(
            ["ps", "-eo", "args="],
            capture_output=True,
            text=True,
            timeout=2,
        )
        for line in result.stdout.splitlines():
            argv = line.strip().split()
            if any(os.path.basename(arg) == basename for arg in argv):
                return True
        return False
    except Exception:
        return False


def stretch_body_server_cmd() -> Optional[str]:
    import shutil

    return shutil.which("stretch_body_server") or os.path.expanduser("~/.local/bin/stretch_body_server")


def gamepad_cmd() -> Optional[str]:
    import shutil

    return shutil.which("stretch_gamepad_teleop") or os.path.expanduser("~/.local/bin/stretch_gamepad_teleop")


def _prepare_ros_command(command: list[str]) -> list[str]:
    """Run ros2 commands through the robot workspace setup when available."""
    if not command or command[0] != "ros2":
        return command
    setup_lines = ["source /opt/ros/jazzy/setup.bash 2>/dev/null || true"]
    setup_lines.append("source ~/ament_ws/install/setup.bash 2>/dev/null || true")
    setup_lines.append(f"exec {shlex.join(command)}")
    return ["bash", "-lc", "; ".join(setup_lines)]


@dataclass
class ManagedProcess:
    name: str
    command: list[str]
    proc: Optional[subprocess.Popen] = None
    started_at: float = 0.0
    log_path: Optional[str] = None

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.running else None


@dataclass
class ProcessManager:
    """Owns long-lived ROS processes. Mode switches stop the previous mode first."""

    processes: dict[str, ManagedProcess] = field(default_factory=dict)
    active_mode: Optional[str] = None

    def start(self, name: str, command: list[str], *, env: Optional[dict] = None) -> ManagedProcess:
        self.stop(name)
        prepared_command = _prepare_ros_command(command)
        logger.info("Starting %s: %s", name, " ".join(prepared_command))
        merged = os.environ.copy()
        merged.update(_load_robot_env())
        local_bin = os.path.expanduser("~/.local/bin")
        merged["PATH"] = f"{local_bin}:{merged.get('PATH', '')}"
        if env:
            merged.update(env)
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
        log_path = f"/tmp/stretch4_nav_webapp_{safe_name}.log"
        log_file = open(log_path, "a", encoding="utf-8")
        log_file.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} starting {' '.join(prepared_command)} ---\n")
        log_file.flush()
        proc = subprocess.Popen(
            prepared_command,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            env=merged,
            preexec_fn=os.setsid,
        )
        log_file.close()
        mp = ManagedProcess(
            name=name,
            command=prepared_command,
            proc=proc,
            started_at=time.time(),
            log_path=log_path,
        )
        self.processes[name] = mp
        return mp

    def stop(self, name: str, timeout: float = 8.0) -> None:
        mp = self.processes.get(name)
        if not mp:
            return
        if not mp.proc:
            self.processes.pop(name, None)
            return

        logger.info("Stopping %s (pid=%s)", name, mp.pid or mp.proc.pid)
        try:
            os.killpg(mp.proc.pid, signal.SIGINT)
        except (ProcessLookupError, OSError):
            try:
                mp.proc.terminate()
            except OSError:
                pass
        try:
            mp.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(mp.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                mp.proc.kill()
            mp.proc.wait(timeout=3)
        self.processes.pop(name, None)

    def stop_mode(self) -> None:
        if self.active_mode:
            # Mode launches include stretch_driver, whose clean shutdown
            # (hardware disconnect via robot.stop()) can take tens of seconds.
            # SIGKILLing it mid-shutdown leaves the robot stack in a bad state,
            # so give ros2 launch time to escalate through its own SIGINT →
            # SIGTERM → SIGKILL sequence before we force anything.
            self.stop(f"mode:{self.active_mode}", timeout=30.0)
            self.active_mode = None
        # These no-op if we never started them (only stop what we started).
        self.stop("gamepad")
        self.stop("body_server")
        # The on-demand camera stack is one or more processes: camera, camera:1, …
        for name in [n for n in self.processes if n == "camera" or n.startswith("camera:")]:
            self.stop(name)

    def set_soft_mode(self, mode_id: str) -> None:
        """Mark a mode active without launching a ROS process (e.g. edit_map)."""
        self.stop_mode()
        self.active_mode = mode_id

    def set_active_mode(self, mode_id: str, command: list[str], *, env: Optional[dict] = None) -> ManagedProcess:
        self.stop_mode()
        mp = self.start(f"mode:{mode_id}", command, env=env)
        self.active_mode = mode_id
        return mp

    def stop_all(self) -> None:
        self.stop_mode()
        for name in list(self.processes.keys()):
            self.stop(name)

    def status(self) -> dict:
        return {
            "active_mode": self.active_mode,
            "processes": {
                name: {
                    "running": mp.running,
                    "pid": mp.pid,
                    "command": mp.command,
                    "started_at": mp.started_at,
                    "log_path": mp.log_path,
                }
                for name, mp in self.processes.items()
            },
        }
