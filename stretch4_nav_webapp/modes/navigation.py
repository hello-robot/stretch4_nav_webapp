"""Navigation mode — Nav2 MPPI, optionally with keepout and/or speed filters."""

from __future__ import annotations

from pathlib import Path

from stretch4_nav_webapp.modes.base import Mode, ModeContext, register, shlex_split_launch
from stretch4_nav_webapp.paths import layer_paths, occupancy_yaml
from stretch4_nav_webapp.robot_status import require_ready


@register
class NavigationMode(Mode):
    id = "navigation"
    label = "Navigation"
    description = "Navigate on a saved map with optional keepout and speed filters."
    needs_robot = True

    def start(self, ctx: ModeContext, **kwargs) -> dict:
        # Guardrail: navigation requires a homed robot. The UI's preflight screen
        # offers Home but never forces it, so "Start anyway" sends
        # skip_readiness and takes responsibility for the state.
        if not kwargs.get("skip_readiness"):
            require_ready(self.id)

        map_name = kwargs.get("map_name")
        if not map_name:
            raise ValueError("map_name is required for navigation")

        maps_dir: Path = ctx.maps_dir
        map_yaml = occupancy_yaml(maps_dir, map_name)
        if not map_yaml.is_file():
            from stretch4_nav_webapp.maps_api import importable_maps

            if map_name in importable_maps(maps_dir):
                # This lands in a toast in front of the user, so it names the
                # button to press, not the endpoint behind it.
                raise FileNotFoundError(
                    f"Map '{map_name}' has not been set up yet. Select it on this "
                    'screen and press "Set up this map", then start navigation again.'
                )
            raise FileNotFoundError(f"Map yaml not found: {map_yaml}")

        keepout_pgm, keepout_yaml = layer_paths(maps_dir, map_name, "keepout")
        speed_pgm, speed_yaml = layer_paths(maps_dir, map_name, "speed")

        # Independent flags; enable_filters=True means both (legacy alias).
        use_keepout = bool(kwargs.get("use_keepout", False))
        use_speed = bool(kwargs.get("use_speed", False))
        if kwargs.get("enable_filters") is True:
            use_keepout = True
            use_speed = True
        if kwargs.get("enable_filters") is False:
            use_keepout = False
            use_speed = False

        if use_keepout and not keepout_yaml.is_file():
            raise FileNotFoundError(f"Keepout mask missing for map '{map_name}'")
        if use_speed and not speed_yaml.is_file():
            raise FileNotFoundError(f"Speed mask missing for map '{map_name}'")

        use_rviz = str(ctx.config.get("use_rviz", "false")).lower()
        launches = ctx.config["launches"]

        if use_keepout or use_speed:
            template = launches["navigation_filters"]
            cmd = shlex_split_launch(
                template,
                map_yaml=str(map_yaml),
                keepout_yaml=str(keepout_yaml) if use_keepout else "",
                speed_yaml=str(speed_yaml) if use_speed else "",
                enable_keepout="true" if use_keepout else "false",
                enable_speed="true" if use_speed else "false",
                use_rviz=use_rviz,
            )
        else:
            template = launches["navigation"]
            cmd = shlex_split_launch(
                template,
                map_yaml=str(map_yaml),
                use_rviz=use_rviz,
            )

        ctx.process_manager.set_active_mode(self.id, cmd)
        ctx.extras["nav_map_name"] = map_name
        return {
            "ok": True,
            "mode": self.id,
            "map_name": map_name,
            "use_keepout": use_keepout,
            "use_speed": use_speed,
            "filters_enabled": use_keepout or use_speed,
            "command": cmd,
            "map_yaml": str(map_yaml),
            "keepout_yaml": str(keepout_yaml) if use_keepout else None,
            "speed_yaml": str(speed_yaml) if use_speed else None,
        }
