"""Import built-in modes so they register themselves."""

from stretch4_nav_webapp.modes import edit_map as _edit_map  # noqa: F401
from stretch4_nav_webapp.modes import mapping as _mapping  # noqa: F401
from stretch4_nav_webapp.modes import navigation as _navigation  # noqa: F401
from stretch4_nav_webapp.modes.base import get_mode, list_modes, register

__all__ = ["get_mode", "list_modes", "register"]
