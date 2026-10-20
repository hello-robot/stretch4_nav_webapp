"""CLI entrypoint: stretch_nav_webapp"""

from __future__ import annotations

import argparse
import logging
import os
import shlex
import sys
from pathlib import Path

import uvicorn

from stretch4_nav_webapp.app import (
    FRONTEND_DIST,
    create_app,
    load_config,
)
from stretch4_nav_webapp.paths import default_maps_dir
from stretch4_nav_webapp.process_manager import ProcessManager, _load_robot_env
from stretch4_nav_webapp.robot_link import RobotLink

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("stretch_nav_webapp")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Stretch4 Nav Webapp — mapping, map editing, and navigation web UI",
    )
    p.add_argument("--port", type=int, default=None, help="UI/API port (default 8080)")
    p.add_argument("--host", default=None, help="Bind host (default 0.0.0.0)")
    p.add_argument("--rosbridge-port", type=int, default=None)
    p.add_argument("--maps-dir", type=Path, default=None)
    p.add_argument("--config", type=Path, default=None, help="Path to config YAML")
    p.add_argument("--no-rosbridge", action="store_true", help="Do not start rosbridge")
    p.add_argument(
        "--disconnected",
        action="store_true",
        help="Start disconnected from the robot: no rosbridge, no robot processes, "
        "only map editing (connect later from the header switch)",
    )
    return p.parse_args(argv)


def _ensure_robot_ros_env() -> None:
    """Make the backend's own ROS features work no matter how it was started.

    Goals, initial pose, and map saving run on an in-process rclpy node, which
    needs (a) the ROS 2 python packages importable and (b) the same RMW as the
    robot's stack. Without (b) the node comes up on the default rmw (FastDDS),
    publishes into the void, and "Set pose does nothing" with no error —
    verified on the robot. Mode launches were never affected because
    process_manager sources the ROS env per launch.

    Merge the robot env (HELLO_FLEET_ID/PATH, RMW_IMPLEMENTATION) into this
    process, then, if rclpy still is not importable, re-exec once through a
    bash that sources the ROS setup files.
    """
    # update(), not setdefault(): process_manager forces the same values onto
    # every mode launch, so a stale RMW_IMPLEMENTATION in the invoking shell
    # would otherwise split the backend and the launches across middlewares.
    os.environ.update(_load_robot_env())
    local_bin = os.path.expanduser("~/.local/bin")
    if local_bin not in os.environ.get("PATH", "").split(":"):
        os.environ["PATH"] = f"{local_bin}:{os.environ.get('PATH', '')}"

    try:
        import rclpy  # noqa: F401

        return
    except ImportError:
        pass

    if os.environ.get("STRETCH4_NAV_WEBAPP_ROS_BOOTSTRAPPED") == "1":
        logger.warning(
            "ROS 2 python packages are unavailable even after sourcing the ROS "
            "setup files — goals, initial pose, and map saving will not work."
        )
        return

    os.environ["STRETCH4_NAV_WEBAPP_ROS_BOOTSTRAPPED"] = "1"
    script = (
        "source /opt/ros/jazzy/setup.bash 2>/dev/null || true; "
        "source ~/ament_ws/install/setup.bash 2>/dev/null || true; "
        f'exec {shlex.quote(sys.executable)} -m stretch4_nav_webapp.cli "$@"'
    )
    logger.info("rclpy not importable — re-executing under a ROS-sourced shell")
    os.execvp("bash", ["bash", "-c", script, "stretch_nav_webapp", *sys.argv[1:]])


def main(argv: list[str] | None = None) -> None:
    _ensure_robot_ros_env()
    # After parse_args: --help/bad-args invocations must never touch processes.
    args = parse_args(argv)
    config = load_config(args.config) if args.config else load_config()

    if args.port is not None:
        config["ui_port"] = args.port
    if args.host is not None:
        config["host"] = args.host
    if args.rosbridge_port is not None:
        config["rosbridge_port"] = args.rosbridge_port
    if args.maps_dir is not None:
        config["maps_dir"] = str(args.maps_dir.expanduser())

    maps_dir = (
        Path(config["maps_dir"]).expanduser()
        if config.get("maps_dir")
        else default_maps_dir()
    )
    maps_dir.mkdir(parents=True, exist_ok=True)

    pm = ProcessManager()
    # Connecting starts rosbridge (unless --no-rosbridge) and clears orphaned
    # launches; disconnected, the app touches nothing on the robot.
    connected = not args.disconnected
    link = RobotLink(pm, config, connected=connected, manage_rosbridge=not args.no_rosbridge)

    app = create_app(config=config, maps_dir=maps_dir, process_manager=pm, robot_link=link)

    host = config.get("host", "0.0.0.0")
    port = int(config.get("ui_port", 8080))

    if not FRONTEND_DIST.is_dir():
        # Installed wheels always ship the built UI; only a git checkout can
        # reach this, and only before the first `npm run build`.
        logger.warning(
            "Built UI missing at %s — run: cd frontend && npm install && npm run build",
            FRONTEND_DIST,
        )

    logger.info("Stretch4 Nav Webapp UI: http://%s:%s  maps=%s", host, port, maps_dir)
    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    finally:
        pm.stop_all()


if __name__ == "__main__":
    main()
