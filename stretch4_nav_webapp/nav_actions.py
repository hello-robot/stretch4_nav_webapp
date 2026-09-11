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
_cmd_vel_pub = None
_undocking = False
_undock_lock = threading.Lock()
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


def undock_robot(duration_sec: float = 3.0, y_velocity: float = -0.1) -> dict[str, Any]:
    """Move sideways off the dock by publishing Twist on /cmd_vel_smoothed.

    Publishing to /cmd_vel_smoothed (not raw /cmd_vel) keeps Nav2's collision
    monitor in the path so motion can still be stopped on obstacle detection.
    """
    global _cmd_vel_pub, _undocking
    from geometry_msgs.msg import Twist

    with _undock_lock:
        if _undocking:
            raise RuntimeError("undock already in progress")
        _undocking = True

    try:
        # Stop any active nav goal so the controller does not fight undock Twist.
        try:
            cancel_navigate_to_pose()
        except Exception as exc:
            logger.warning("undock: cancel goal before undock failed: %s", exc)

        with _lock:
            _ensure_rclpy()
            if _cmd_vel_pub is None:
                # Publish to the collision_monitor's input (cmd_vel_in_topic =
                # /cmd_vel_nav), which relays to /cmd_vel -> stretch_driver. The
                # previous /cmd_vel_smoothed had *zero* subscribers on this robot
                # (velocity_smoother's output is unused), so undock never moved.
                _cmd_vel_pub = _node.create_publisher(Twist, "/cmd_vel_nav", 10)
            pub = _cmd_vel_pub

        logger.info(
            "undock: sideways at %.3f m/s for %.1fs via /cmd_vel_nav",
            y_velocity,
            duration_sec,
        )
        twist = Twist()
        twist.linear.x = 0.0
        twist.linear.y = float(y_velocity)
        twist.angular.z = 0.0

        start = time.time()
        while (time.time() - start) < duration_sec:
            pub.publish(twist)
            _spin_once(0.05)
            time.sleep(0.1)

        return {
            "ok": True,
            "duration_sec": duration_sec,
            "y_velocity": y_velocity,
        }
    finally:
        try:
            if _cmd_vel_pub is not None:
                stop = Twist()
                _cmd_vel_pub.publish(stop)
                _spin_once(0.05)
        except Exception as exc:
            logger.warning("undock: failed to publish stop Twist: %s", exc)
        with _undock_lock:
            _undocking = False
