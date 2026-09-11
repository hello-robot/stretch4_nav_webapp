"""Mode base class and registry."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ModeContext:
    maps_dir: Any  # pathlib.Path
    process_manager: Any
    config: dict
    extras: dict = field(default_factory=dict)


class Mode(ABC):
    id: str = ""
    label: str = ""
    description: str = ""
    needs_robot: bool = True

    @abstractmethod
    def start(self, ctx: ModeContext, **kwargs) -> dict:
        ...

    def stop(self, ctx: ModeContext) -> dict:
        ctx.process_manager.stop_mode()
        return {"ok": True, "mode": self.id, "stopped": True}

    def metadata(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "needs_robot": self.needs_robot,
        }


_REGISTRY: dict[str, Mode] = {}


def register(cls_or_mode):
    """Register a Mode subclass (class decorator) or Mode instance."""
    mode = cls_or_mode() if isinstance(cls_or_mode, type) else cls_or_mode
    if not getattr(mode, "id", None):
        raise ValueError("Mode.id is required")
    _REGISTRY[mode.id] = mode
    return cls_or_mode


def get_mode(mode_id: str) -> Optional[Mode]:
    return _REGISTRY.get(mode_id)


def list_modes() -> list[dict]:
    return [m.metadata() for m in _REGISTRY.values()]


def shlex_split_launch(template: str, **subs: str) -> list[str]:
    """Format a launch template string and split into argv.

    Drops any ``name:=`` token whose value rendered empty. ``ros2 launch``
    rejects an empty-valued argument ("malformed launch argument 'name:=',
    expected format '<name>:=<value>'") and aborts the whole launch, so an
    optional substitution left blank (e.g. speed_mask when only keepout is on)
    must be omitted entirely, matching an equivalent hand-typed command.
    """
    import re
    import shlex

    rendered = template.format(**subs)
    empty_arg = re.compile(r"^[^\s:=]+:=$")
    return [tok for tok in shlex.split(rendered) if not empty_arg.match(tok)]
