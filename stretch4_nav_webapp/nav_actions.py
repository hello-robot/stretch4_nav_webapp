"""NavigateToPose action client helpers (optional rclpy)."""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_rclpy_ok = False
_node = None
_action_client = None
_goal_handle = None
_initial_pose_pub = None
_lock = threading.Lock()


def _ensure_rclpy():
    global _rclpy_ok, _node, _action_client
    if _rclpy_ok:
        return
    try:
        import rclpy
        from rclpy.action import ActionClient
        from nav2_msgs.action import NavigateToPose
    except ImportError as exc:
        raise RuntimeError(
            "rclpy/nav2_msgs not available. Source your ROS 2 workspace before sending goals."
        ) from exc

    if not rclpy.ok():
        rclpy.init(args=None)
    _node = rclpy.create_node("stretch4_nav_webapp_goal_client")
    _action_client = ActionClient(_node, NavigateToPose, "navigate_to_pose")
    _rclpy_ok = True


def _spin_once(timeout_sec: float = 0.1) -> None:
    import rclpy

    rclpy.spin_once(_node, timeout_sec=timeout_sec)


def yaw_to_quaternion(yaw: float) -> dict[str, float]:
    return {
        "x": 0.0,
        "y": 0.0,
        "z": math.sin(yaw / 2.0),
        "w": math.cos(yaw / 2.0),
    }


def send_navigate_to_pose(
    x: float,
    y: float,
    yaw: float = 0.0,
    frame_id: str = "map",
    wait_server_sec: float = 10.0,
) -> dict[str, Any]:
    """Send a NavigateToPose goal. Returns immediately after acceptance."""
    global _goal_handle
    from nav2_msgs.action import NavigateToPose
    from geometry_msgs.msg import PoseStamped

    with _lock:
        _ensure_rclpy()
        if not _action_client.wait_for_server(timeout_sec=wait_server_sec):
            raise TimeoutError("navigate_to_pose action server not available")

        goal = NavigateToPose.Goal()
        pose = PoseStamped()
        pose.header.frame_id = frame_id
        pose.header.stamp = _node.get_clock().now().to_msg()
        pose.pose.position.x = float(x)
        pose.pose.position.y = float(y)
        pose.pose.position.z = 0.0
        q = yaw_to_quaternion(float(yaw))
        pose.pose.orientation.x = q["x"]
        pose.pose.orientation.y = q["y"]
        pose.pose.orientation.z = q["z"]
        pose.pose.orientation.w = q["w"]
        goal.pose = pose

        send_future = _action_client.send_goal_async(goal)
        while not send_future.done():
            _spin_once(0.1)
        goal_handle = send_future.result()
        if not goal_handle or not goal_handle.accepted:
            raise RuntimeError("NavigateToPose goal rejected")
        _goal_handle = goal_handle
        return {"ok": True, "x": x, "y": y, "yaw": yaw, "frame_id": frame_id}


def cancel_navigate_to_pose() -> dict[str, Any]:
    global _goal_handle
    with _lock:
        _ensure_rclpy()
        if _goal_handle is None:
            # No goal was sent from this process, so there is nothing to cancel
            # via the in-process action client. (A previous shell fallback that
            # spawned `ros2 action send_goal --cancel` was removed: as a raw
            # subprocess it did not inherit RMW_IMPLEMENTATION=rmw_zenoh_cpp and
            # never reached the Nav2 action server under rmw_zenoh.)
            return {"ok": True, "cancelled": False, "note": "no active goal"}
        cancel_future = _goal_handle.cancel_goal_async()
        while not cancel_future.done():
            _spin_once(0.1)
        _goal_handle = None
        return {"ok": True, "cancelled": True}


def save_map_via_service(
    map_url: str, map_topic: str = "/map", timeout_sec: float = 15.0
) -> dict[str, Any]:
    """Save the current map through nav2's /map_saver/save_map service.

    Preferred over hand-writing the PGM/YAML: it is an in-process rclpy service
    client on the shared node (RMW auto-matched, no env hardcoding) and produces
    exactly what nav2 map_saver would. ``map_url`` is the output path prefix; the
    saver writes ``<map_url>.pgm`` and ``<map_url>.yaml``. Requires a running
    map_saver_server (added to the mapping launch); raises if it is unavailable
    so the caller can fall back.
    """
    from nav2_msgs.srv import SaveMap

    with _lock:
        _ensure_rclpy()
        client = _node.create_client(SaveMap, "/map_saver/save_map")
        try:
            if not client.wait_for_service(timeout_sec=min(timeout_sec, 5.0)):
                raise RuntimeError(
                    "/map_saver/save_map unavailable (is map_saver_server running?)"
                )
            req = SaveMap.Request()
            req.map_topic = map_topic
            req.map_url = str(map_url)
            req.image_format = "pgm"
            req.map_mode = "trinary"
            req.free_thresh = 0.25
            req.occupied_thresh = 0.65

            future = client.call_async(req)
            start = time.time()
            while not future.done() and (time.time() - start) < timeout_sec:
                _spin_once(0.1)
            if not future.done():
                raise TimeoutError("SaveMap service call timed out")
            resp = future.result()
            if resp is None or not resp.result:
                raise RuntimeError("map_saver reported failure saving the map")
            return {"ok": True}
        finally:
            _node.destroy_client(client)


def set_initial_pose(x: float, y: float, yaw: float = 0.0) -> dict[str, Any]:
    """Publish /initialpose so AMCL relocalizes the robot.

    Publishing straight from the browser over rosbridge is unreliable (the
    advertise/publish race drops the single message under rmw_zenoh). Here we
    use a persistent, latched (TRANSIENT_LOCAL + RELIABLE) publisher on the
    backend ROS node and send it a few times so AMCL reliably receives it.

    Even so, the first call after backend start races zenoh discovery: a burst
    of publishes in the first ~250ms after create_publisher is lost before AMCL
    matches (verified on the robot — AMCL kept warning "Please set the initial
    pose"). So wait for the subscription to match first, then keep publishing
    over ~2s.
    """
    global _initial_pose_pub
    from geometry_msgs.msg import PoseWithCovarianceStamped
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

    with _lock:
        _ensure_rclpy()
        if _initial_pose_pub is None:
            qos = QoSProfile(depth=1)
            qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
            qos.reliability = ReliabilityPolicy.RELIABLE
            _initial_pose_pub = _node.create_publisher(
                PoseWithCovarianceStamped, "/initialpose", qos
            )
        pub = _initial_pose_pub

    # Everything below runs OUTSIDE _lock: neither the graph query nor
    # publish() needs the shared node spun, and a slow discovery here must
    # not block a concurrent Cancel goal (which takes the same lock) for
    # seconds while the robot is moving.
    deadline = time.time() + 5.0
    while time.time() < deadline and pub.get_subscription_count() == 0:
        time.sleep(0.1)
    matched = pub.get_subscription_count() > 0
    if not matched:
        logger.warning(
            "initial pose: no /initialpose subscriber matched after 5s "
            "(is navigation running?); publishing anyway"
        )

    msg = PoseWithCovarianceStamped()
    msg.header.frame_id = "map"
    msg.header.stamp = _node.get_clock().now().to_msg()
    msg.pose.pose.position.x = float(x)
    msg.pose.pose.position.y = float(y)
    msg.pose.pose.position.z = 0.0
    q = yaw_to_quaternion(float(yaw))
    msg.pose.pose.orientation.x = q["x"]
    msg.pose.pose.orientation.y = q["y"]
    msg.pose.pose.orientation.z = q["z"]
    msg.pose.pose.orientation.w = q["w"]
    cov = [0.0] * 36
    cov[0] = 0.25    # x variance
    cov[7] = 0.25    # y variance
    cov[35] = 0.0685  # yaw variance
    msg.pose.covariance = cov

    # Publish several times spread over ~1s so AMCL definitely gets it, even
    # if the match above was detected slightly before delivery works.
    for _ in range(8):
        pub.publish(msg)
        time.sleep(0.15)
    return {
        "ok": True,
        "x": x,
        "y": y,
        "yaw": yaw,
        "frame_id": "map",
        "matched": matched,
    }


# --- Docking -----------------------------------------------------------------
# Docking and undocking go through stretch_nav2's docking_server.py and
# undocking_server.py

# DockRobot.Feedback.state -> what the robot is doing.
DOCK_PHASES = {
    1: "Driving to the dock",
    2: "Looking for the dock",
    3: "Lining up with the dock",
    4: "Waiting for the charger",
    5: "Lost sight of the dock, trying again",
}

# stretch_nav2's own error codes, beside nav2's 9xx ones (which carry error_msg).
_STRETCH_DOCK_ERRORS = {
    800: "Replaced by a newer dock request.",
    801: "Could not stow the arm before docking.",
    802: "Not enough clear space beside the dock to undock.",
}

_dock_client = None
_undock_client = None
_spinner_started = False
_dock_lock = threading.Lock()
_dock: dict[str, Any] = {
    "action": None,  # "dock" | "undock" | None
    "state": "idle",  # idle | active | cancelling | succeeded | failed | cancelled
    "phase": None,
    "message": "",
    "handle": None,
    "seq": 0,
    "since": 0.0,
}


def _ensure_spinner() -> None:
    """Spin the shared node in the background so action results and feedback arrive.

    Every spin happens under ``_lock``, so it never overlaps the in-call
    spinning the other helpers here do.
    """
    global _spinner_started
    if _spinner_started:
        return
    _spinner_started = True

    def run() -> None:
        while True:
            try:
                with _lock:
                    _spin_once(0.0)
            except Exception as exc:  # noqa: BLE001 - keep spinning through a bad callback
                logger.warning("docking spinner: %s", exc)
            time.sleep(0.05)

    threading.Thread(target=run, daemon=True, name="nav-actions-spin").start()


def _ensure_docking_clients():
    global _dock_client, _undock_client
    from rclpy.action import ActionClient
    from nav2_msgs.action import DockRobot, UndockRobot

    with _lock:
        _ensure_rclpy()
        if _dock_client is None:
            _dock_client = ActionClient(_node, DockRobot, "dock_robot")
            _undock_client = ActionClient(_node, UndockRobot, "undock_robot")
    _ensure_spinner()
    return _dock_client, _undock_client


def _set_dock(seq: int, **fields) -> None:
    """Update the docking status, unless a newer request has replaced this one."""
    with _dock_lock:
        if _dock["seq"] == seq:
            _dock.update(fields)


def _result_message(action: str, result) -> str:
    if result.success:
        return "Docked." if action == "dock" else "Undocked."
    code = int(result.error_code)
    detail = (result.error_msg or "").strip() or _STRETCH_DOCK_ERRORS.get(code, "")
    verb = "Docking" if action == "dock" else "Undocking"
    return f"{verb} failed ({code}): {detail}" if detail else f"{verb} failed ({code})."


def _send_dock_goal(action: str, client, goal, wait_server_sec: float) -> dict[str, Any]:
    from action_msgs.msg import GoalStatus

    name, server = (
        ("dock_robot", "docking_server") if action == "dock" else ("undock_robot", "undocking_server")
    )
    if not client.wait_for_server(timeout_sec=wait_server_sec):
        raise TimeoutError(
            f"{name} action server not available (is stretch_nav2's {server} "
            "running? It starts with navigation.)"
        )

    with _dock_lock:
        if _dock["state"] in ("active", "cancelling"):
            raise RuntimeError(f"{_dock['action']} already in progress")
        _dock["seq"] += 1
        seq = _dock["seq"]
        _dock.update(
            action=action, state="active", phase=None, message="", handle=None,
            since=time.time(),
        )

    def on_feedback(msg) -> None:
        phase = DOCK_PHASES.get(int(getattr(msg.feedback, "state", 0)))
        if phase:
            _set_dock(seq, phase=phase)

    def on_result(future) -> None:
        try:
            wrapped = future.result()
        except Exception as exc:  # noqa: BLE001
            _set_dock(seq, state="failed", message=str(exc), handle=None)
            return
        if wrapped.status == GoalStatus.STATUS_CANCELED:
            _set_dock(seq, state="cancelled", message="Cancelled.", handle=None)
            return
        result = wrapped.result
        _set_dock(
            seq,
            state="succeeded" if result.success else "failed",
            message=_result_message(action, result),
            handle=None,
        )

    try:
        with _lock:
            send_future = client.send_goal_async(goal, feedback_callback=on_feedback)
        deadline = time.time() + 10.0
        while not send_future.done() and time.time() < deadline:
            time.sleep(0.05)  # the spinner resolves it
        if not send_future.done():
            raise TimeoutError(f"{name} did not answer the goal request")
        handle = send_future.result()
        if not handle or not handle.accepted:
            raise RuntimeError(f"{name} goal rejected")
    except Exception as exc:
        _set_dock(seq, state="failed", message=str(exc))
        raise

    _set_dock(seq, handle=handle)
    with _lock:
        handle.get_result_async().add_done_callback(on_result)
    return {"ok": True, "action": action, "started": True}


def dock_robot(x: float, y: float, yaw: float, wait_server_sec: float = 5.0) -> dict[str, Any]:
    """Dock on the dock at (x, y, yaw), a docking_station_link pose in the map frame.

    The docking server drives there through Nav2 itself, starts looking for the
    dock once it is close, and servos onto the charger, so no separate goal is
    needed.
    """
    from nav2_msgs.action import DockRobot

    client, _ = _ensure_docking_clients()
    try:
        cancel_navigate_to_pose()  # the server's own Nav2 goal replaces ours anyway
    except Exception as exc:  # noqa: BLE001
        logger.warning("dock: cancel goal before docking failed: %s", exc)

    goal = DockRobot.Goal()
    goal.use_dock_id = False
    goal.navigate_to_staging_pose = True
    # Stamp left at zero, meaning "latest transform", like stretch4_patrol does.
    goal.dock_pose.header.frame_id = "map"
    goal.dock_pose.pose.position.x = float(x)
    goal.dock_pose.pose.position.y = float(y)
    q = yaw_to_quaternion(float(yaw))
    goal.dock_pose.pose.orientation.z = q["z"]
    goal.dock_pose.pose.orientation.w = q["w"]
    return _send_dock_goal("dock", client, goal, wait_server_sec)


def undock_robot(wait_server_sec: float = 5.0) -> dict[str, Any]:
    """Slide off the dock through the undocking server, which checks the space first."""
    from nav2_msgs.action import UndockRobot

    _, client = _ensure_docking_clients()
    try:
        # Stop any active nav goal so the controller does not fight the undock.
        cancel_navigate_to_pose()
    except Exception as exc:  # noqa: BLE001
        logger.warning("undock: cancel goal before undock failed: %s", exc)
    return _send_dock_goal("undock", client, UndockRobot.Goal(), wait_server_sec)


def cancel_docking(timeout_sec: float = 5.0) -> dict[str, Any]:
    """Cancel a dock / undock in progress. A no-op when nothing is running."""
    with _dock_lock:
        handle = _dock["handle"]
        seq = _dock["seq"]
        if handle is None or _dock["state"] != "active":
            return {"ok": True, "cancelled": False}
        _dock["state"] = "cancelling"
    with _lock:
        future = handle.cancel_goal_async()
    deadline = time.time() + timeout_sec
    while not future.done() and time.time() < deadline:
        time.sleep(0.05)
    if not future.done():
        _set_dock(seq, state="active")
        raise TimeoutError("docking server did not answer the cancel request")
    return {"ok": True, "cancelled": True}


def dock_status() -> dict[str, Any]:
    """What the last dock / undock request is doing, for the UI to poll."""
    with _dock_lock:
        return {
            "action": _dock["action"],
            "state": _dock["state"],
            "phase": _dock["phase"],
            "message": _dock["message"],
            "elapsed": round(time.time() - _dock["since"], 1) if _dock["since"] else None,
        }
