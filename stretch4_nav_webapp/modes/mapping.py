"""Mapping mode — slam_toolbox offline mapping launch."""

from __future__ import annotations

from pathlib import Path

from stretch4_nav_webapp.modes.base import Mode, ModeContext, register, shlex_split_launch
from stretch4_nav_webapp.process_manager import gamepad_cmd, process_running, stretch_body_server_cmd
from stretch4_nav_webapp.robot_status import require_ready

# Module-level aliases so tests can monkeypatch them here.
_stretch_body_server_cmd = stretch_body_server_cmd
_gamepad_cmd = gamepad_cmd


def _body_server_running() -> bool:
    return process_running("stretch_body_server")


def _gamepad_running() -> bool:
    return process_running("stretch_gamepad_teleop")


@register
class MappingMode(Mode):
    id = "mapping"
    label = "Mapping"
    description = "Build a map with slam_toolbox (stretch_nav2 offline_mapping)."
    needs_robot = True

    def start(self, ctx: ModeContext, **kwargs) -> dict:
        # Guardrail: block until the robot is homed + stowed and the gamepad
        # dongle is connected (people drive manually to build the map). The UI's
        # preflight screen offers Home/Stow but never forces them, so "Start
        # anyway" sends skip_readiness and takes responsibility for the state.
        if not kwargs.get("skip_readiness"):
            require_ready(self.id)

        ctx.process_manager.stop_mode()

        body_server_cmd = _stretch_body_server_cmd()
        body_server_started = False
        if body_server_cmd and Path(body_server_cmd).is_file() and not _body_server_running():
            ctx.process_manager.start("body_server", [body_server_cmd, "--launch"])
            body_server_started = True

        # The Stretch gamepad teleop is usually already running system-wide. If
        # not, start it in the background so people can drive during mapping.
        # Tracked as "gamepad" so stop_mode() stops it *only if we started it*.
        gamepad_cmd = _gamepad_cmd()
        gamepad_started = False
        if gamepad_cmd and Path(gamepad_cmd).is_file() and not _gamepad_running():
            ctx.process_manager.start("gamepad", [gamepad_cmd])
            gamepad_started = True

        use_rviz = str(ctx.config.get("use_rviz", "false")).lower()
        template = ctx.config["launches"]["mapping"]
        cmd = shlex_split_launch(template, use_rviz=use_rviz)
        ctx.process_manager.start(f"mode:{self.id}", cmd)
        ctx.process_manager.active_mode = self.id
        return {
            "ok": True,
            "mode": self.id,
            "command": cmd,
            "body_server_started": body_server_started,
            "gamepad_started": gamepad_started,
        }
