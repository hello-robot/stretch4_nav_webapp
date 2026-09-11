"""Edit-map mode — no robot launch; file editing only."""

from __future__ import annotations

from stretch4_nav_webapp.modes.base import Mode, ModeContext, register


@register
class EditMapMode(Mode):
    id = "edit_map"
    label = "Edit Map"
    description = "Edit occupancy, keepout, and speed filter layers for a saved map."
    needs_robot = False

    def start(self, ctx: ModeContext, **kwargs) -> dict:
        # Stop any robot mode but do not launch ROS.
        ctx.process_manager.set_soft_mode(self.id)
        map_name = kwargs.get("map_name") or ""
        ctx.extras["edit_map_name"] = map_name
        return {"ok": True, "mode": self.id, "map_name": map_name}
