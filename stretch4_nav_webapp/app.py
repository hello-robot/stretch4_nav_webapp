"""FastAPI application for Stretch4 Nav Webapp."""

import logging
import os
import shlex
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import stretch4_nav_webapp.modes  # noqa: F401 — register modes
from stretch4_nav_webapp.map_transform import (
    explored_bounds,
    has_backup,
    restore_backup,
    transform_map,
)
from stretch4_nav_webapp.maps_api import (
    import_map,
    list_maps,
    load_layer,
    load_locations,
    load_semantic_regions,
    save_layer,
    save_locations,
    save_map_from_slam,
    save_semantic_regions,
)
from stretch4_nav_webapp.modes.base import ModeContext, get_mode, list_modes
from stretch4_nav_webapp.nav_actions import (
    cancel_navigate_to_pose,
    send_navigate_to_pose,
    set_initial_pose,
    undock_robot,
)
from stretch4_nav_webapp.paths import default_maps_dir
from stretch4_nav_webapp.process_manager import (
    ProcessManager,
    gamepad_cmd,
    process_running,
    stretch_body_server_cmd,
)
from stretch4_nav_webapp.robot_assets import resolve_mesh_path, rewrite_urdf_mesh_urls

logger = logging.getLogger(__name__)


PKG_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = PKG_DIR / "config" / "default.yaml"
FRONTEND_DIST = PKG_DIR / "static"


def _fetch_robot_description_param() -> str:
    """Best-effort: ros2 param get from common node names."""

    if not shutil.which("ros2"):
        return ""
    candidates = [
        ("/robot_state_publisher", "robot_description"),
        ("/stretch_driver", "robot_description"),
        ("robot_state_publisher", "robot_description"),
    ]
    for node, param in candidates:
        try:
            ros_cmd = ["ros2", "param", "get", "--no-daemon", node, param]
            setup = [
                "source /opt/ros/jazzy/setup.bash 2>/dev/null || true",
                "source ~/ament_ws/install/setup.bash 2>/dev/null || true",
            ]
            if os.path.exists("/opt/ros/jazzy/lib/librmw_zenoh_cpp.so"):
                setup.append("export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION:-rmw_zenoh_cpp}")
            setup.append(f"exec {shlex.join(ros_cmd)}")
            result = subprocess.run(
                ["bash", "-lc", "; ".join(setup)],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                continue
            text = result.stdout
            # Output like: String value is: <?xml ...
            marker = "String value is:"
            if marker in text:
                return text.split(marker, 1)[1].strip()
            if "<robot" in text:
                return text.strip()
        except Exception:
            continue
    return ""


def _read_robot_env() -> dict[str, str]:
    env: dict[str, str] = {}
    conf = Path("/etc/hello-robot/hello-robot.conf")
    if conf.is_file():
        for line in conf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def _deep_update(base: dict, override: dict) -> dict:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_update(base[key], value)
        else:
            base[key] = value
    return base


def _fetch_robot_description_from_config() -> str:
    """Build URDF from Stretch YAML config when robot_description is not live."""
    try:
        from stretch4_urdf import get_urdf
    except Exception:
        return ""

    robot_env = {**_read_robot_env(), **os.environ}
    fleet_id = robot_env.get("HELLO_FLEET_ID")
    fleet_path = Path(robot_env.get("HELLO_FLEET_PATH", str(Path.home() / "stretch_user"))).expanduser()
    if not fleet_id:
        return ""

    params: dict[str, Any] = {}
    for base in (Path("/etc/hello-robot"), fleet_path):
        for name in ("stretch_configuration_params.yaml", "stretch_user_params.yaml"):
            path = base / fleet_id / name
            if not path.is_file():
                continue
            try:
                with path.open("r", encoding="utf-8") as f:
                    _deep_update(params, yaml.safe_load(f) or {})
            except Exception:
                logger.exception("Failed to read robot params from %s", path)

    robot = params.get("robot") if isinstance(params.get("robot"), dict) else {}
    model_name = robot.get("model_name")
    batch_name = robot.get("batch_name")
    tool_name = robot.get("tool")
    if not (model_name and batch_name and tool_name):
        return ""

    try:
        return get_urdf(model_name, batch_name, tool_name, True)
    except Exception:
        logger.exception(
            "Failed to build URDF from robot params: model=%s batch=%s tool=%s",
            model_name,
            batch_name,
            tool_name,
        )
        return ""


class ModeStartBody(BaseModel):
    map_name: Optional[str] = None
    enable_filters: Optional[bool] = None  # legacy: true => both keepout+speed
    use_keepout: bool = False
    use_speed: bool = False
    # Set by the UI's "Start anyway" escape hatch: the readiness panel offers
    # Home/Stow but never forces them, so the guardrail must be skippable.
    skip_readiness: bool = False


class RunstopBody(BaseModel):
    engaged: bool


class SaveMapBody(BaseModel):
    name: str = Field(..., min_length=1)


class LayerSaveBody(BaseModel):
    width: int
    height: int
    pixels: list[int]
    resolution: Optional[float] = None
    origin: Optional[list[float]] = None


class Location(BaseModel):
    id: Optional[str] = None
    name: str
    x: float
    y: float
    yaw: float = 0.0


class LocationsBody(BaseModel):
    locations: list[Location]


class SemanticRegion(BaseModel):
    # id is the pixel value painted into semantic.pgm.
    id: int = Field(..., ge=1, le=255)
    name: str = Field(..., min_length=1)
    color: str = "#3d9cf0"


class SemanticBody(BaseModel):
    regions: list[SemanticRegion]


class CropBox(BaseModel):
    left: int = Field(..., ge=0)
    top: int = Field(..., ge=0)
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)


class TransformBody(BaseModel):
    crop: Optional[CropBox] = None
    # "keep" trims to the box; "remove" wipes the box to blank.
    crop_mode: Literal["keep", "remove"] = "keep"
    # Counter-clockwise, as the map looks on screen.
    rotate_deg: float = 0.0


class GoalBody(BaseModel):
    x: float
    y: float
    yaw: float = 0.0
    frame_id: str = "map"


def load_config(path: Optional[Path] = None) -> dict:
    cfg_path = path or DEFAULT_CONFIG_PATH
    with cfg_path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def create_app(
    *,
    config: Optional[dict] = None,
    maps_dir: Optional[Path] = None,
    process_manager: Optional[ProcessManager] = None,
) -> FastAPI:
    config = config or load_config()
    maps_root = Path(maps_dir) if maps_dir else (
        Path(config["maps_dir"]).expanduser() if config.get("maps_dir") else default_maps_dir()
    )
    pm = process_manager or ProcessManager()
    ctx = ModeContext(maps_dir=maps_root, process_manager=pm, config=config)

    app = FastAPI(title="Stretch4 Nav Webapp", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.config = config
    app.state.maps_dir = maps_root
    app.state.pm = pm
    app.state.ctx = ctx

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/status")
    def status():
        # dongle_connected is a cheap filesystem check, safe for the 4s poll and
        # used by the global joystick icon. Homed/stowed live under /api/robot/readiness.
        from stretch4_nav_webapp.robot_status import dongle_connected

        return {
            "ok": True,
            "maps_dir": str(maps_root),
            "rosbridge_port": config.get("rosbridge_port", 9090),
            "ui_port": config.get("ui_port", 8080),
            "dongle_connected": dongle_connected(),
            "modes": list_modes(),
            **pm.status(),
        }

    @app.get("/api/robot/readiness")
    def robot_readiness():
        from stretch4_nav_webapp.robot_status import get_readiness

        return get_readiness()

    @app.post("/api/robot/home")
    def robot_home():
        from stretch4_nav_webapp.robot_status import start_home

        try:
            return start_home()
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/robot/stow")
    def robot_stow():
        from stretch4_nav_webapp.robot_status import start_stow

        try:
            return start_stow()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/robot/runstop")
    def robot_runstop(body: RunstopBody):
        """Engage (stop everything) or release the runstop.
        """
        from stretch4_nav_webapp.robot_status import set_runstop

        try:
            return set_runstop(body.engaged)
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.post("/api/robot/gamepad/start")
    def robot_gamepad_start():
        """Start gamepad teleop on demand (Actions menu).

        stretch_gamepad_teleop drives the robot through stretch_body_server, so
        bring that up first if nothing else has. Both are tracked in the process
        manager only when the app starts them, so stop_mode() leaves a system-wide
        gamepad alone.
        """
        body_server_started = False
        body_cmd = stretch_body_server_cmd()
        if body_cmd and Path(body_cmd).is_file() and not process_running("stretch_body_server"):
            pm.start("body_server", [body_cmd, "--launch"])
            body_server_started = True

        cmd = gamepad_cmd()
        if not (cmd and Path(cmd).is_file()):
            raise HTTPException(500, "stretch_gamepad_teleop not found on this robot")
        gamepad_started = False
        if not process_running("stretch_gamepad_teleop"):
            pm.start("gamepad", [cmd])
            gamepad_started = True
        return {
            "ok": True,
            "running": True,
            "gamepad_started": gamepad_started,
            "body_server_started": body_server_started,
        }

    def _camera_config() -> dict:
        cam = config.get("camera") or {}
        # `launches` is a list (driver + republish); `launch` is the legacy
        # single-command form.
        launches = cam.get("launches") or ([cam["launch"]] if cam.get("launch") else [])
        return {
            "launches": [str(c) for c in launches],
            "post_start": [str(c) for c in (cam.get("post_start") or [])],
            "topic": cam.get("topic") or "",
            "rotate_deg": int(cam.get("rotate_deg", 0)),
            "label": cam.get("label") or "Camera",
        }

    def _run_camera_post_start(commands: list[str]) -> None:
        """Retry one-shot ros2 commands (e.g. param set) until the camera node is up.

        The camera takes ~20-30s to appear on the graph, and runtime params die
        with the node — so this runs after every start, in the background,
        retrying each command until it succeeds or the deadline passes.
        """
        from stretch4_nav_webapp.process_manager import _load_robot_env, _prepare_ros_command

        env = os.environ.copy()
        env.update(_load_robot_env())
        env["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{env.get('PATH', '')}"

        def worker() -> None:
            pending = list(commands)
            deadline = time.time() + 120
            while pending and time.time() < deadline:
                try:
                    res = subprocess.run(
                        _prepare_ros_command(shlex.split(pending[0])),
                        capture_output=True,
                        text=True,
                        timeout=20,
                        env=env,
                    )
                    if res.returncode == 0:
                        logger.info("camera post_start ok: %s", pending.pop(0))
                        continue
                except Exception:
                    pass
                time.sleep(5)
            if pending:
                logger.warning("camera post_start commands never applied: %s", pending)

        threading.Thread(target=worker, daemon=True, name="camera-post-start").start()

    def _camera_proc_names() -> list[str]:
        return [n for n in pm.processes if n == "camera" or n.startswith("camera:")]

    @app.get("/api/camera/status")
    def camera_status():
        cam = _camera_config()
        names = _camera_proc_names()
        # The first process is the camera driver — the one whose liveness matters.
        mp = pm.processes.get("camera")
        return {
            "running": bool(mp and mp.running),
            "processes": names,
            "topic": cam["topic"],
            "rotate_deg": cam["rotate_deg"],
            "label": cam["label"],
        }

    @app.post("/api/camera/start")
    def camera_start():
        cam = _camera_config()
        if not cam["launches"]:
            raise HTTPException(400, "No camera launch configured (config key: camera.launches)")
        mp = pm.processes.get("camera")
        if not (mp and mp.running):
            for i, launch in enumerate(cam["launches"]):
                name = "camera" if i == 0 else f"camera:{i}"
                pm.start(name, shlex.split(launch))
            if cam["post_start"]:
                _run_camera_post_start(cam["post_start"])
        return camera_status()

    @app.post("/api/camera/stop")
    def camera_stop():
        for name in _camera_proc_names():
            pm.stop(name)
        return camera_status()

    @app.get("/api/modes")
    def modes():
        return {"modes": list_modes()}

    @app.post("/api/modes/{mode_id}/start")
    def start_mode(mode_id: str, body: ModeStartBody = None):
        if body is None:
            body = ModeStartBody()
        mode = get_mode(mode_id)
        if not mode:
            raise HTTPException(404, f"Unknown mode: {mode_id}")
        try:
            kwargs: dict[str, Any] = {}
            if body.map_name is not None:
                kwargs["map_name"] = body.map_name
            if body.enable_filters is not None:
                kwargs["enable_filters"] = body.enable_filters
            kwargs["use_keepout"] = bool(body.use_keepout)
            kwargs["use_speed"] = bool(body.use_speed)
            kwargs["skip_readiness"] = bool(body.skip_readiness)
            return mode.start(ctx, **kwargs)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            logger.exception("Failed to start mode %s", mode_id)
            raise HTTPException(500, str(exc)) from exc

    @app.post("/api/modes/stop")
    def stop_mode():
        pm.stop_mode()
        return {"ok": True, "stopped": True}

    @app.post("/api/mapping/save")
    def mapping_save(body: SaveMapBody):
        try:
            return save_map_from_slam(maps_root, body.name)
        except Exception as exc:
            logger.exception("map save failed")
            raise HTTPException(500, str(exc)) from exc

    @app.get("/api/maps")
    def maps_list():
        return {"maps": list_maps(maps_root), "maps_dir": str(maps_root)}

    @app.post("/api/maps/{name}/setup")
    def maps_setup(name: str):
        """Copy a map that isn't in the app's layout into maps/<name>/.

        The picker offers this for any map listed with needs_setup; the user's
        original files are left untouched.
        """
        try:
            dest = import_map(maps_root, name)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - unreadable image / bad YAML
            logger.exception("map setup failed for %s", name)
            raise HTTPException(400, str(exc)) from exc
        return {"ok": True, "name": name, "path": str(dest)}

    @app.get("/api/maps/{name}/layer/{layer}")
    def maps_layer_get(name: str, layer: str):
        try:
            return load_layer(maps_root, name, layer)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/maps/{name}/layer/{layer}")
    def maps_layer_save(name: str, layer: str, body: LayerSaveBody):
        meta = {}
        if body.resolution is not None:
            meta["resolution"] = body.resolution
        if body.origin is not None:
            meta["origin"] = body.origin
        try:
            return save_layer(
                maps_root,
                name,
                layer,
                width=body.width,
                height=body.height,
                pixels=body.pixels,
                meta=meta or None,
            )
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/maps/{name}/semantic")
    def get_semantic(name: str):
        return {"regions": load_semantic_regions(maps_root, name)}

    @app.put("/api/maps/{name}/semantic")
    def put_semantic(name: str, body: SemanticBody):
        try:
            regions = save_semantic_regions(
                maps_root, name, [r.model_dump() for r in body.regions]
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"regions": regions}

    @app.get("/api/maps/{name}/transform")
    def get_transform_info(name: str):
        """What a "trim to the explored area" crop would use, and undo state."""
        try:
            return {
                "explored_bounds": explored_bounds(maps_root, name),
                "can_undo": has_backup(maps_root, name),
            }
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/maps/{name}/transform")
    def post_transform(name: str, body: TransformBody):
        try:
            return transform_map(
                maps_root,
                name,
                crop=body.crop.model_dump() if body.crop else None,
                crop_mode=body.crop_mode,
                rotate_deg=body.rotate_deg,
            )
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/maps/{name}/transform/undo")
    def post_transform_undo(name: str):
        try:
            return restore_backup(maps_root, name)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/maps/{name}/locations")
    def get_locations(name: str):
        return {"locations": load_locations(maps_root, name)}

    @app.put("/api/maps/{name}/locations")
    def put_locations(name: str, body: LocationsBody):
        locs = [loc.model_dump() for loc in body.locations]
        for i, loc in enumerate(locs):
            if not loc.get("id"):
                loc["id"] = f"loc_{i}_{loc['name']}"
        return {"locations": save_locations(maps_root, name, locs)}

    @app.post("/api/navigation/goal")
    def nav_goal(body: GoalBody):
        try:
            return send_navigate_to_pose(body.x, body.y, body.yaw, body.frame_id)
        except Exception as exc:
            logger.exception("goal failed")
            raise HTTPException(503, str(exc)) from exc

    @app.post("/api/navigation/cancel")
    def nav_cancel():
        try:
            return cancel_navigate_to_pose()
        except Exception as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.post("/api/navigation/initial_pose")
    def nav_initial_pose(body: GoalBody):
        try:
            return set_initial_pose(body.x, body.y, body.yaw)
        except Exception as exc:
            logger.exception("initial pose failed")
            raise HTTPException(503, str(exc)) from exc

    @app.post("/api/navigation/undock")
    def nav_undock():
        try:
            return undock_robot()
        except Exception as exc:
            logger.exception("undock failed")
            raise HTTPException(503, str(exc)) from exc

    @app.get("/api/robot/meshes/{full_path:path}")
    def robot_mesh(full_path: str, v: str = ""):
        path = resolve_mesh_path(full_path)
        if not path or not path.is_file():
            raise HTTPException(404, f"Mesh not found: {full_path}")
        # a changed file gets a new URL.
        cache = "public, max-age=31536000, immutable" if v else "no-cache"
        return FileResponse(path, headers={"Cache-Control": cache})

    @app.get("/api/robot/description")
    def robot_description():
        urdf = _fetch_robot_description_param() or _fetch_robot_description_from_config()
        if not urdf:
            raise HTTPException(
                404,
                "robot_description not found and URDF could not be built from robot config",
            )
        host = "/api/robot/meshes"
        return {"urdf": rewrite_urdf_mesh_urls(urdf, host), "raw": True}

    @app.post("/api/robot/rewrite-urdf")
    def rewrite_urdf(body: dict):
        """Rewrite package:// mesh URLs in a URDF string for the browser."""
        urdf = body.get("urdf") or ""
        if not urdf:
            raise HTTPException(400, "urdf required")
        host = body.get("mesh_base_url") or "/api/robot/meshes"
        return {"urdf": rewrite_urdf_mesh_urls(urdf, host)}

    if FRONTEND_DIST.is_dir():
        assets = FRONTEND_DIST / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

        @app.get("/")
        def index():
            return FileResponse(FRONTEND_DIST / "index.html")

        @app.get("/{full_path:path}")
        def spa_fallback(full_path: str):
            candidate = FRONTEND_DIST / full_path
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


app = create_app()
