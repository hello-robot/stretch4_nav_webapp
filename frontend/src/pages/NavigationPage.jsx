import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useRosTopic } from '../hooks/useRosTopic';
import { useUrdfRobot } from '../hooks/useUrdfRobot';
import PreflightScreen from '../components/PreflightScreen';
import MapViewer, { dockYawFromFacing } from '../components/MapViewer';
import CameraPanel from '../components/CameraPanel';
import {
  lookupPose,
  orientationFromYaw,
  poseToXYYaw,
  robotPoseFromTf,
  scanPointsInMap,
  tfBufferToMessage,
  updateTfBuffer,
} from '../utils/tf';

const TOOLS = [
  { id: 'view', label: 'Pan', title: 'Move the map: left-drag to pan, scroll to zoom.' },
  { id: 'initial', label: 'Set pose', title: 'Tell the robot where it is: click-drag where it actually stands.' },
];

const TOOL_HINT = {
  initial: 'Click-drag on the map where the robot actually is; the arrow sets its facing.',
  location: 'Placing a location — click-drag on the map.',
  dock: 'Placing the dock — click-drag on the map.',
  goal: 'The map is armed for Set goal.',
  view: 'Pan: left-drag to move the map, scroll to zoom. Neither of these moves the robot.',
};

const LAYERS = [
  { key: 'map', label: 'Map', title: 'The saved occupancy map you started with.' },
  { key: 'robot', label: 'Robot', title: 'The 3D Stretch model at its current pose.' },
  { key: 'dock', label: 'Dock', title: 'The charging dock marked on this map.' },
  { key: 'scan', label: 'Laser scan', title: 'Live lidar hits — what the robot can see right now.' },
  { key: 'globalCostmap', label: 'Global costmap', title: 'Where Nav2 thinks it is expensive or unsafe to drive, across the whole map.' },
  { key: 'localCostmap', label: 'Local costmap', title: 'Obstacles right around the robot, updated live.' },
  { key: 'keepoutMask', label: 'Keepout zones', title: 'The no-go zones navigation is actually enforcing' },
  { key: 'speedMask', label: 'Speed zones', title: 'The slow-down zones navigation is actually enforcing' },
  { key: 'plan', label: 'Planned path', title: 'The route Nav2 intends to drive to the current goal.' },
  { key: 'footprint', label: 'Footprint', title: "The outline the robot's base occupies." },
];

function poseFromAmcl(msg) {
  if (!msg?.pose?.pose) return null;
  const p = msg.pose.pose.position;
  const o = msg.pose.pose.orientation;
  const yaw = Math.atan2(2 * (o.w * o.z + o.x * o.y), 1 - 2 * (o.y * o.y + o.z * o.z));
  return { x: p.x, y: p.y, yaw };
}

function poseFromXYYaw(pose) {
  if (!pose) return null;
  return {
    position: { x: pose.x, y: pose.y, z: 0 },
    orientation: orientationFromYaw(pose.yaw ?? 0),
  };
}

// /api/navigation/dock/status state -> .cp-goal-status look.
const DOCK_STATUS_LOOK = {
  active: 'driving',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  succeeded: 'reached',
  failed: 'failed',
};
const DOCK_ACTIVE = ['active', 'cancelling'];

function dockStatusText(task) {
  if (!task) return '';
  if (task.state === 'active') {
    if (task.action === 'undock') return 'Undocking…';
    return `${task.phase || 'Starting to dock'}…`;
  }
  if (task.state === 'cancelling') return 'Cancelling — the robot is stopping…';
  return task.message || '';
}

async function fetchRobotDescription() {
  try {
    const res = await api('/api/robot/description');
    return res?.urdf || '';
  } catch {
    return '';
  }
}

export default function NavigationPage({
  rosbridgeUrl,
  initialMapName = '',
  navActive = false,
  robot,
  onStatusRefresh,
  onError,
  onBusy,
}) {
  const { readiness, refresh, home, stow } = robot;
  const [maps, setMaps] = useState([]);
  const [mapName, setMapName] = useState(initialMapName);
  const [useKeepout, setUseKeepout] = useState(false);
  const [useSpeed, setUseSpeed] = useState(false);
  const [clickMode, setClickMode] = useState('view');
  const [goalPose, setGoalPose] = useState(null);
  const [locations, setLocations] = useState([]);
  const [filtersNote, setFiltersNote] = useState('');
  const [notice, setNotice] = useState('');
  const [urdfXml, setUrdfXml] = useState('');
  const [starting, setStarting] = useState(false);
  const [startedUnchecked, setStartedUnchecked] = useState(false);

  // Location placement / saving UI state.
  const [placing, setPlacing] = useState(false); // "Place on map" mode active
  const [pendingLocation, setPendingLocation] = useState(null); // {x,y,yaw} dropped on map
  const [pendingName, setPendingName] = useState('');
  const [robotFormOpen, setRobotFormOpen] = useState(false);
  const [robotName, setRobotName] = useState('');
  const [initialPoseMarker, setInitialPoseMarker] = useState(null); // brief set-pose confirm

  // Charging dock: the one marked on this map, placing a new one, and the
  // dock / undock request in flight (polled from the backend).
  const [dock, setDock] = useState(null); // { id, x, y, yaw, source }
  const [dockXml, setDockXml] = useState('');
  const [placingDock, setPlacingDock] = useState(false);
  const [pendingDock, setPendingDock] = useState(null); // { x, y, yaw } dropped on map
  const [dockTask, setDockTask] = useState(null); // /api/navigation/dock/status
  const [dockRequesting, setDockRequesting] = useState(false);
  // "Find dock": park near the dock, localize, then discover_dock finds it.
  const [findOpen, setFindOpen] = useState(false);
  const [discovery, setDiscovery] = useState(null); // /api/navigation/dock/discover

  // First-run card over the map. Session-only: retired when the user sets a
  // pose or closes it; every fresh navigation launch shows it again while
  // the robot is unlocalized.
  const [poseCardDismissed, setPoseCardDismissed] = useState(false);
  // "Session" means one navigation run, not one page visit: stopping and
  // starting navigation again leaves this component mounted, so without the
  // reset below the card stays retired and the second run never asks for a
  // pose.
  useEffect(() => {
    if (navActive) setPoseCardDismissed(false);
  }, [navActive]);
  const [pulseSetPose, setPulseSetPose] = useState(false);

  const [showMap, setShowMap] = useState(true);
  const [showRobot, setShowRobot] = useState(true);
  const [showDock, setShowDock] = useState(true);
  const [showScan, setShowScan] = useState(true);
  const [showGlobalCostmap, setShowGlobalCostmap] = useState(true);
  const [showLocalCostmap, setShowLocalCostmap] = useState(true);
  const [showKeepoutMask, setShowKeepoutMask] = useState(true);
  const [showSpeedMask, setShowSpeedMask] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [showFootprint, setShowFootprint] = useState(true);

  const tfBuffer = useRef(new Map());
  const segRef = useRef(null);

  const live = navActive;

  // Every OccupancyGrid here is subscribed with CBOR. As JSON, a map of any
  // real size crosses rosbridge's 1 MB max_message_size, gets split into
  // `fragment` ops, and is dropped outright by roslib which makes the map never
  // appears. CBOR sends the same grid as one binary frame a third the size.
  const { data: mapMsg } = useRosTopic(rosbridgeUrl, '/map', 'nav_msgs/OccupancyGrid', {
    throttleMs: 1000,
    enabled: live,
    compression: 'cbor',
  });
  const { data: globalCostmap } = useRosTopic(
    rosbridgeUrl,
    '/global_costmap/costmap',
    'nav_msgs/OccupancyGrid',
    { throttleMs: 400, enabled: live && showGlobalCostmap, compression: 'cbor' }
  );
  const { data: localCostmap } = useRosTopic(
    rosbridgeUrl,
    '/local_costmap/costmap',
    'nav_msgs/OccupancyGrid',
    { throttleMs: 200, enabled: live && showLocalCostmap, compression: 'cbor' }
  );
  // The exact grids the costmap filters consume, latched by the mask servers.
  // Absent (and silently empty) when the matching filter wasn't enabled.
  const { data: keepoutMask } = useRosTopic(
    rosbridgeUrl,
    '/keepout_filter_mask',
    'nav_msgs/OccupancyGrid',
    { throttleMs: 1000, enabled: live && showKeepoutMask, compression: 'cbor' }
  );
  const { data: speedMask } = useRosTopic(
    rosbridgeUrl,
    '/speed_filter_mask',
    'nav_msgs/OccupancyGrid',
    { throttleMs: 1000, enabled: live && showSpeedMask, compression: 'cbor' }
  );
  // /scan_filtered stays subscribed while navigation runs (not only when the
  // layer is shown): it doubles as the "Lidar" health signal below. The raw
  // fallback is only worth its bandwidth when the layer is visible.
  const { data: scanFiltered } = useRosTopic(rosbridgeUrl, '/scan_filtered', 'sensor_msgs/LaserScan', {
    throttleMs: 100,
    enabled: live,
  });
  const { data: rawScan } = useRosTopic(rosbridgeUrl, '/scan', 'sensor_msgs/LaserScan', {
    throttleMs: 100,
    enabled: live && showScan,
  });
  const { data: plan } = useRosTopic(rosbridgeUrl, '/plan', 'nav_msgs/Path', {
    throttleMs: 200,
    enabled: live && showPlan,
  });
  const { data: footprint } = useRosTopic(
    rosbridgeUrl,
    '/local_costmap/published_footprint',
    'geometry_msgs/PolygonStamped',
    { throttleMs: 100, enabled: live && showFootprint }
  );
  const { data: tfDyn } = useRosTopic(rosbridgeUrl, '/tf', 'tf2_msgs/TFMessage', {
    throttleMs: 50,
    enabled: live,
  });
  const { data: tfStatic } = useRosTopic(rosbridgeUrl, '/tf_static', 'tf2_msgs/TFMessage', {
    enabled: live,
  });
  const { data: jointStates } = useRosTopic(rosbridgeUrl, '/joint_states', 'sensor_msgs/JointState', {
    throttleMs: 100,
    enabled: live,
  });
  const { data: robotDescMsg } = useRosTopic(rosbridgeUrl, '/robot_description', 'std_msgs/String', {
    enabled: live,
  });
  const { data: amcl } = useRosTopic(
    rosbridgeUrl,
    '/amcl_pose',
    'geometry_msgs/PoseWithCovarianceStamped',
    { throttleMs: 150, enabled: live }
  );
  // Nav2's own goal status.
  const { data: goalStatusMsg } = useRosTopic(
    rosbridgeUrl,
    '/navigate_to_pose/_action/status',
    'action_msgs/GoalStatusArray',
    { enabled: live }
  );

  useEffect(() => {
    if (tfStatic) updateTfBuffer(tfBuffer.current, tfStatic);
  }, [tfStatic]);
  useEffect(() => {
    if (tfDyn) updateTfBuffer(tfBuffer.current, tfDyn);
  }, [tfDyn]);

  useEffect(() => {
    if (robotDescMsg?.data) {
      setUrdfXml(robotDescMsg.data);
      return;
    }
    fetchRobotDescription().then((u) => {
      if (u) setUrdfXml(u);
    });
  }, [robotDescMsg]);

  const tfMsg = useMemo(() => tfBufferToMessage(tfBuffer.current), [tfDyn, tfStatic]);
  const robotPose = robotPoseFromTf(tfMsg) || poseFromAmcl(amcl);
  const scan = scanFiltered || rawScan;
  const laserFrame = scan?.header?.frame_id || 'laser';
  const laserPose =
    lookupPose(tfMsg, laserFrame) ||
    lookupPose(tfMsg, 'base_link') ||
    lookupPose(tfMsg, 'base_footprint') ||
    poseFromXYYaw(robotPose);
  const scanPoints = useMemo(
    () => (showScan ? scanPointsInMap(scan, laserPose, { stride: 2 }) : new Float32Array(0)),
    [scan, laserPose, showScan]
  );
  // The local costmap rolls in an odom frame (e.g. wheel_odom); resolve that
  // frame's pose in map so the overlay tracks the robot after relocalization.
  const localCostmapPose = useMemo(() => {
    const frame = localCostmap?.header?.frame_id;
    if (!frame) return null;
    return poseToXYYaw(lookupPose(tfMsg, frame));
  }, [localCostmap, tfMsg]);
  // The published footprint is oriented in the same rolling odom frame; place it
  // by that frame's pose in map so it sits under the robot after relocalization.
  const footprintPose = useMemo(() => {
    const frame = footprint?.header?.frame_id;
    if (!frame) return null;
    return poseToXYYaw(lookupPose(tfMsg, frame));
  }, [footprint, tfMsg]);
  const { robot: urdfRobot } = useUrdfRobot(urdfXml, showRobot);

  useEffect(() => {
    if (!live || dockXml) return;
    api('/api/robot/dock/description')
      .then((res) => setDockXml(res?.urdf || ''))
      .catch(() => {}); // no model: the viewer falls back to a plain marker
  }, [live, dockXml]);
  const { robot: dockModel } = useUrdfRobot(dockXml, showDock);

  // Robot systems health. Everything that failed silently during bring-up on a
  // real robot (driver not publishing, lidar dead, never localized) surfaces
  // here instead of leaving a newcomer staring at an empty map.
  const lastSeenRef = useRef({ joints: 0, scan: 0, mapPose: 0 });
  const liveSinceRef = useRef(0);
  const localizedSeenRef = useRef(false);
  const [localizedSeen, setLocalizedSeen] = useState(false);
  useEffect(() => {
    if (jointStates) lastSeenRef.current.joints = Date.now();
  }, [jointStates]);
  useEffect(() => {
    if (scanFiltered) lastSeenRef.current.scan = Date.now();
  }, [scanFiltered]);
  useEffect(() => {
    if (rawScan) lastSeenRef.current.scan = Date.now();
  }, [rawScan]);
  const markLocalizedSeen = () => {
    lastSeenRef.current.mapPose = Date.now();
    if (!localizedSeenRef.current) {
      localizedSeenRef.current = true;
      setLocalizedSeen(true);
    }
  };

  useEffect(() => {
    const hasMap = tfDyn?.transforms?.some(
      (t) => (t.header?.frame_id || '').replace(/^\//, '') === 'map'
    );
    if (hasMap) markLocalizedSeen();
  }, [tfDyn]);
  useEffect(() => {
    if (amcl) markLocalizedSeen();
  }, [amcl]);
  const [, setHealthTick] = useState(0);
  useEffect(() => {
    if (!live) {
      // Reset between sessions, or a restart would open on "not answering"
      // instead of "starting up" — and clear the TF buffer so the previous
      // session's map→odom edge can't place the robot on the wrong map.
      lastSeenRef.current = { joints: 0, scan: 0, mapPose: 0 };
      liveSinceRef.current = 0;
      localizedSeenRef.current = false;
      setLocalizedSeen(false);
      tfBuffer.current.clear();
      return undefined;
    }
    liveSinceRef.current = Date.now();
    const t = setInterval(() => setHealthTick((v) => v + 1), 1500);
    return () => clearInterval(t);
  }, [live]);

  // 'waiting' = stack still booting. After 60s of silence it is not booting
  // any more — promote to the failure state instead of promising "~30s" forever.
  const healthState = (lastSeen) => {
    if (!lastSeen) {
      const bootingFor = liveSinceRef.current ? Date.now() - liveSinceRef.current : 0;
      return bootingFor > 60000 ? 'stale' : 'waiting';
    }
    return Date.now() - lastSeen < 6000 ? 'ok' : 'stale';
  };
  const driverHealth = healthState(lastSeenRef.current.joints);
  const lidarHealth = healthState(lastSeenRef.current.scan);
  const localized = localizedSeen;

  const HEALTH = [
    {
      key: 'driver',
      label: 'Driver',
      state: driverHealth,
      title: {
        ok: 'The robot body is answering.',
        waiting: 'Waiting for the robot body to start answering. Takes ~30s after starting navigation.',
        stale: 'The robot body is not answering. Stop navigation and start it again; if it keeps happening, restart the robot.',
      }[driverHealth],
    },
    {
      key: 'lidar',
      label: 'Lidar',
      state: lidarHealth,
      title: {
        ok: 'Laser scans are flowing.',
        waiting: 'Waiting for the first laser scan. Takes ~30s after starting navigation.',
        stale: 'No laser scans are arriving. Stop navigation and start it again.',
      }[lidarHealth],
    },
    {
      key: 'localized',
      label: 'Localized',
      state: localized ? 'ok' : 'todo',
      title: localized
        ? 'The robot knows where it is on the map.'
        : 'The robot does not know where it is yet — use Set pose.',
    },
  ];
  
  const healthIssue = HEALTH.find((h) => h.key !== 'localized' && h.state !== 'ok');

  // Goal lifecycle line, driven by /navigate_to_pose/_action/status.
  // action_msgs/GoalStatus codes: 1 accepted, 2 executing, 3 canceling,
  // 4 succeeded, 5 canceled, 6 aborted.
  const [goalFeedback, setGoalFeedback] = useState(null);
  const activeGoalIdsRef = useRef(new Set());
  useEffect(() => {
    if (!live) {
      activeGoalIdsRef.current.clear();
      setGoalFeedback(null);
    }
  }, [live]);
  useEffect(() => {
    // log when there is a message shape mismatch and skip the update instead of crashing.
    try {
      const list = goalStatusMsg?.status_list;
      if (!list?.length) return;
      // Goals are listed in acceptance order; the last entry is the current one.
      const entry = list[list.length - 1];
      const uuidField = entry.goal_info?.goal_id?.uuid;
      const uuid = Array.isArray(uuidField) ? uuidField.join(',') : String(uuidField ?? '');
      const seen = activeGoalIdsRef.current;
      if (entry.status >= 1 && entry.status <= 3) {
        seen.add(uuid);
        setGoalFeedback(entry.status === 3 ? 'cancelling' : 'driving');
        return;
      }
      if (!seen.has(uuid)) return;
      seen.delete(uuid);
      if (entry.status === 4) setGoalFeedback('reached');
      else if (entry.status === 5) setGoalFeedback('cancelled');
      else if (entry.status === 6) setGoalFeedback('failed');
      setGoalPose(null);
    } catch (err) {
      console.error('[nav] could not process /navigate_to_pose/_action/status message:', err, goalStatusMsg);
    }
  }, [goalStatusMsg]);

  const GOAL_FEEDBACK = {
    driving: 'Driving to the goal…',
    cancelling: 'Cancelling — the robot is stopping…',
    cancelled: 'Goal cancelled.',
    reached: 'Goal reached.',
    failed: 'The robot could not reach the goal. Try sending the goal again.',
  };

  const flashNotice = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const dismissPoseCard = () => {
    if (poseCardDismissed) return;
    setPoseCardDismissed(true);
    setPulseSetPose(true);
    setTimeout(() => setPulseSetPose(false), 2400);
  };

  const selectedMap = useMemo(
    () => maps.find((m) => m.name === mapName) || null,
    [maps, mapName]
  );

  const refreshMaps = async () => {
    try {
      const res = await api('/api/maps');
      setMaps(res.maps || []);
    } catch (err) {
      onError?.(err.message);
    }
  };

  useEffect(() => {
    refreshMaps();
  }, []);

  // A map copied into the maps folder by hand keeps its own file names, so the
  // app can see it but not run it. One click converts a copy into the layout
  // every mode expects; the user's original files stay where they are.
  const [settingUp, setSettingUp] = useState(false);
  const setUpMap = async () => {
    if (!mapName || settingUp) return;
    setSettingUp(true);
    try {
      await api(`/api/maps/${encodeURIComponent(mapName)}/setup`, { method: 'POST' });
      await refreshMaps();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSettingUp(false);
    }
  };

  useEffect(() => {
    if (!mapName || !navActive) {
      if (!mapName) setLocations([]);
      return;
    }
    (async () => {
      try {
        const [locs, dockRes] = await Promise.all([
          api(`/api/maps/${encodeURIComponent(mapName)}/locations`),
          api(`/api/maps/${encodeURIComponent(mapName)}/dock`),
        ]);
        setLocations(locs.locations || []);
        setDock(dockRes.dock || null);
      } catch (err) {
        onError?.(err.message);
      }
    })();
  }, [mapName, navActive]);

  // Follow a dock / undock while it runs. Also picks up one already running
  // when the page is reloaded mid-dock.
  const dockActive = DOCK_ACTIVE.includes(dockTask?.state);
  const refreshDockTask = async () => {
    try {
      setDockTask(await api('/api/navigation/dock/status'));
    } catch {
      // keep the last known state on a transient error
    }
  };
  useEffect(() => {
    if (!live) {
      setDockTask(null);
      return undefined;
    }
    refreshDockTask();
    return undefined;
  }, [live]);
  useEffect(() => {
    if (!live || !dockActive) return undefined;
    const t = setInterval(refreshDockTask, 1000);
    return () => clearInterval(t);
  }, [live, dockActive]);

  const discovering = !!discovery?.running;
  const refreshDiscovery = async () => {
    try {
      const res = await api('/api/navigation/dock/discover');
      setDiscovery(res);
      // Show what it found on the map, unsaved, until the user keeps or drops it.
      if (res?.found) setPendingDock({ x: res.found.x, y: res.found.y, yaw: res.found.yaw });
    } catch {
      // keep the last known state on a transient error
    }
  };
  useEffect(() => {
    if (!live || !discovering) return undefined;
    const t = setInterval(refreshDiscovery, 1000);
    return () => clearInterval(t);
  }, [live, discovering]);

  useEffect(() => {
    if (!selectedMap?.keepout_painted) setUseKeepout(false);
    if (!selectedMap?.speed_painted) setUseSpeed(false);
  }, [selectedMap]);

  const filterHelp = (painted, has, paintedText, kind) => {
    if (painted) return paintedText;
    if (has) return `The ${kind} layer is empty — paint zones in Edit Map first.`;
    return `This map has no ${kind} layer — paint one in Edit Map.`;
  };

  const startNav = async ({ skipReadiness } = {}) => {
    if (!mapName) {
      onError?.('Select a map first');
      return;
    }
    setStarting(true);
    onBusy?.(true);
    try {
      const res = await api('/api/modes/navigation/start', {
        method: 'POST',
        body: JSON.stringify({
          map_name: mapName,
          use_keepout: useKeepout,
          use_speed: useSpeed,
          skip_readiness: !!skipReadiness,
        }),
      });
      const parts = [];
      if (res.use_keepout) parts.push('keepout');
      if (res.use_speed) parts.push('speed');
      setFiltersNote(
        parts.length
          ? `Filters: ${parts.join(' + ')}`
          : 'Plain MPPI (no keepout/speed filters)'
      );
      setStartedUnchecked(!!skipReadiness);
      await onStatusRefresh?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setStarting(false);
      onBusy?.(false);
    }
  };

  const stopNav = async () => {
    onBusy?.(true);
    try {
      await api('/api/modes/stop', { method: 'POST', body: '{}' });
      setGoalPose(null);
      setFiltersNote('');
      setStartedUnchecked(false);
      setClickMode('view');
      setPlacing(false);
      setPendingLocation(null);
      setPlacingDock(false);
      setPendingDock(null);
      setDockTask(null);
      setFindOpen(false);
      setDiscovery(null);
      await onStatusRefresh?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      onBusy?.(false);
    }
  };

  const sendGoal = async (pose) => {
    onBusy?.(true);
    try {
      await api('/api/navigation/goal', {
        method: 'POST',
        body: JSON.stringify({ x: pose.x, y: pose.y, yaw: pose.yaw ?? 0 }),
      });
      setGoalPose(pose);
      setGoalFeedback('driving');
      flashNotice('Goal sent');
    } catch (err) {
      onError?.(err.message);
    } finally {
      onBusy?.(false);
    }
  };

  // Also stops a dock / undock: the backend cancels whichever is running.
  const cancelGoal = async () => {
    const wasDocking = dockActive;
    if (!wasDocking) setGoalFeedback('cancelling');
    try {
      const res = await api('/api/navigation/cancel', { method: 'POST', body: '{}' });
      setGoalPose(null);
      if (!wasDocking) setGoalFeedback(res?.cancelled ? 'cancelled' : null);
    } catch (err) {
      setGoalFeedback(null);
      onError?.(err.message);
    }
    if (wasDocking) refreshDockTask();
  };

  // action: 'dock' | 'undock'. Both run on stretch_nav2's docking servers.
  const runDockAction = async (action) => {
    if (dockRequesting || dockActive) return;
    setDockRequesting(true);
    try {
      const res = await api(`/api/navigation/${action}`, { method: 'POST', body: '{}' });
      if (res?.started === false) {
        // Already where it was asked to be — nothing was sent.
        flashNotice(res.message);
        return;
      }
      setGoalPose(null);
      setGoalFeedback(null);
      setDockTask({ action, state: 'active', phase: null, message: '' });
    } catch (err) {
      onError?.(err.message);
      refreshDockTask();
    } finally {
      setDockRequesting(false);
    }
  };

  const onPose = async (pose) => {
    if (pose.mode === 'goal') {
      await sendGoal(pose);
      setClickMode('view'); // return to pan so the map is draggable again
      return;
    }
    if (pose.mode === 'initial') {
      // Publish via the backend (reliable) instead of a browser rosbridge publish.
      try {
        await api('/api/navigation/initial_pose', {
          method: 'POST',
          body: JSON.stringify({ x: pose.x, y: pose.y, yaw: pose.yaw ?? 0 }),
        });
        setInitialPoseMarker({ x: pose.x, y: pose.y, yaw: pose.yaw ?? 0 });
        setTimeout(() => setInitialPoseMarker(null), 4000);
        flashNotice('Initial pose sent');
        dismissPoseCard();
      } catch (err) {
        onError?.(err.message);
      }
      setClickMode('view'); // return to pan so the map is draggable again
      return;
    }
    if (pose.mode === 'location') {
      // Drop / adjust a location; the name + save happen in the side panel.
      setPendingLocation({ x: pose.x, y: pose.y, yaw: pose.yaw ?? 0 });
    }
    if (pose.mode === 'dock') {
      // The drag is the way the dock faces; the stored pose is the dock's own frame.
      setPendingDock({ x: pose.x, y: pose.y, yaw: dockYawFromFacing(pose.yaw ?? 0) });
    }
  };

  const persistLocations = async (next) => {
    setLocations(next);
    if (!mapName) return;
    try {
      await api(`/api/maps/${encodeURIComponent(mapName)}/locations`, {
        method: 'PUT',
        body: JSON.stringify({ locations: next }),
      });
    } catch (err) {
      onError?.(err.message);
    }
  };

  // Toggle a pose-click mode (Set pose / Set goal). Re-clicking the active mode
  // returns to 'view' (pan), so the map is always draggable when no tool is armed.
  const selectClickMode = (mode) => {
    setClickMode((cur) => (cur === mode ? 'view' : mode));
    setPlacing(false);
    setPendingLocation(null);
    setPendingName('');
    setPlacingDock(false);
    setPendingDock(null);
  };

  // Arrow keys move through the segmented control. Unlike selectClickMode this
  // sets the mode outright — toggling back to 'view' would fight the arrow keys.
  const onSegKey = (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const current = TOOLS.some((t) => t.id === clickMode) ? clickMode : 'view';
    const i = TOOLS.findIndex((t) => t.id === current);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = TOOLS[(i + step + TOOLS.length) % TOOLS.length];
    setClickMode(next.id);
    setPlacing(false);
    setPendingLocation(null);
    setPendingName('');
    setPlacingDock(false);
    setPendingDock(null);
    segRef.current?.querySelector(`[data-tool="${next.id}"]`)?.focus();
  };

  // "Place on map": enter placement mode; the user click-drags on the map.
  const startPlaceOnMap = () => {
    setRobotFormOpen(false);
    setPlacingDock(false);
    setPendingDock(null);
    setPendingLocation(null);
    setPendingName('');
    setPlacing(true);
    setClickMode('location');
  };

  const cancelPlace = () => {
    setPlacing(false);
    setPendingLocation(null);
    setPendingName('');
    setClickMode('view');
  };

  const savePlacedLocation = () => {
    if (!pendingLocation) return;
    const name = pendingName.trim() || `loc_${locations.length + 1}`;
    persistLocations([
      ...locations,
      {
        id: `loc_${Date.now()}`,
        name,
        x: pendingLocation.x,
        y: pendingLocation.y,
        yaw: pendingLocation.yaw ?? 0,
      },
    ]);
    cancelPlace();
  };

  // Marking the dock works like placing a location: drop it, adjust, Save.
  const startPlaceDock = () => {
    if (findOpen) closeFindDock();
    setRobotFormOpen(false);
    setPlacing(false);
    setPendingLocation(null);
    setPendingName('');
    setPendingDock(null);
    setPlacingDock(true);
    setClickMode('dock');
  };

  const cancelPlaceDock = () => {
    setPlacingDock(false);
    setPendingDock(null);
    setClickMode('view');
  };

  const saveDock = async () => {
    if (!pendingDock || !mapName) return;
    try {
      const res = await api(`/api/maps/${encodeURIComponent(mapName)}/dock`, {
        method: 'PUT',
        body: JSON.stringify(pendingDock),
      });
      setDock(res.dock || null);
      flashNotice('Dock saved');
      cancelPlaceDock();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const openFindDock = () => {
    cancelPlaceDock();
    setDiscovery(null);
    setFindOpen(true);
  };

  const startDiscovery = async () => {
    setPendingDock(null);
    try {
      setDiscovery(await api('/api/navigation/dock/discover/start', { method: 'POST', body: '{}' }));
    } catch (err) {
      onError?.(err.message);
    }
  };

  const closeFindDock = async () => {
    setFindOpen(false);
    setPendingDock(null);
    setDiscovery(null);
    try {
      await api('/api/navigation/dock/discover/stop', { method: 'POST', body: '{}' });
    } catch (err) {
      onError?.(err.message);
    }
  };

  const keepFoundDock = async () => {
    await saveDock();
    setFindOpen(false);
    setDiscovery(null);
  };

  const removeDock = async () => {
    if (!mapName) return;
    try {
      const res = await api(`/api/maps/${encodeURIComponent(mapName)}/dock`, { method: 'DELETE' });
      setDock(res.dock || null);
    } catch (err) {
      onError?.(err.message);
    }
  };

  // "Save robot's spot": name a location at the robot's current pose (map frame).
  const openRobotForm = () => {
    if (!robotPose) {
      onError?.('No robot pose yet — set the pose first.');
      return;
    }
    setPlacing(false);
    setPendingLocation(null);
    setRobotName('');
    setRobotFormOpen(true);
  };

  const saveRobotLocation = () => {
    if (!robotPose) {
      onError?.('No robot pose yet — set the pose first.');
      return;
    }
    const name = robotName.trim() || `loc_${locations.length + 1}`;
    persistLocations([
      ...locations,
      { id: `loc_${Date.now()}`, name, x: robotPose.x, y: robotPose.y, yaw: robotPose.yaw ?? 0 },
    ]);
    setRobotFormOpen(false);
    setRobotName('');
  };

  const layerShown = {
    map: showMap,
    robot: showRobot,
    dock: showDock,
    scan: showScan,
    globalCostmap: showGlobalCostmap,
    localCostmap: showLocalCostmap,
    keepoutMask: showKeepoutMask,
    speedMask: showSpeedMask,
    plan: showPlan,
    footprint: showFootprint,
  };
  const setLayer = {
    map: setShowMap,
    robot: setShowRobot,
    dock: setShowDock,
    scan: setShowScan,
    globalCostmap: setShowGlobalCostmap,
    localCostmap: setShowLocalCostmap,
    keepoutMask: setShowKeepoutMask,
    speedMask: setShowSpeedMask,
    plan: setShowPlan,
    footprint: setShowFootprint,
  };
  const shownLayers = LAYERS.filter((l) => layerShown[l.key]).length;

  const mapHelp = !selectedMap
    ? 'Maps are saved under your fleet maps folder.'
    : selectedMap.needs_setup
      ? 'This map is not in the layout this app uses, so it cannot be navigated yet.'
    : selectedMap.keepout_painted && selectedMap.speed_painted
      ? 'This map has painted keepout and speed zones.'
      : selectedMap.keepout_painted
        ? 'This map has painted keepout zones.'
        : selectedMap.speed_painted
          ? 'This map has painted speed zones.'
          : 'No keepout or speed zones painted yet — add them in Edit Map if you want them.';

  // Every hook is above this line — the preflight screen is a full-page state.
  if (!navActive) {
    return (
      <PreflightScreen
        mode="navigation"
        readiness={readiness}
        onHome={home}
        onStow={stow}
        onRefresh={refresh}
        onError={onError}
        starting={starting}
        blocker={
          !mapName
            ? 'Pick a map first.'
            : selectedMap?.needs_setup
              ? 'Set this map up before navigating.'
              : null
        }
        onStart={startNav}
      >
        <div className="pf-field">
          <label className="pf-field__label" htmlFor="pf-map">Map</label>
          <select id="pf-map" value={mapName} onChange={(e) => setMapName(e.target.value)}>
            <option value="">— pick a map —</option>
            {maps.map((m) => (
              <option key={m.name} value={m.name}>
                {m.needs_setup ? `${m.name} — needs setup` : m.name}
              </option>
            ))}
          </select>
          <p className="pf-field__help">{mapHelp}</p>
          {selectedMap?.needs_setup && (
            <div className="pf-setup" role="status">
              <p className="pf-setup__text">
                <strong>{mapName}</strong> didnt come from the app — its files are not
                named the way this app expects. Set it up and a copy is made in the right
                layout, with empty keepout and speed zones ready to paint. Your original
                files are left untouched.
              </p>
              <button
                type="button"
                className="btn"
                disabled={settingUp}
                onClick={setUpMap}
              >
                {settingUp ? 'Setting up…' : 'Set up this map'}
              </button>
            </div>
          )}
        </div>

        <label className="pf-toggle">
          <input
            type="checkbox"
            checked={useKeepout}
            disabled={!selectedMap?.keepout_painted}
            onChange={(e) => setUseKeepout(e.target.checked)}
          />
          <span className="pf-toggle__label">Keepout filter</span>
          <span className="pf-toggle__help">
            {filterHelp(
              selectedMap?.keepout_painted,
              selectedMap?.has_keepout,
              'Keep the robot out of the areas you painted in Edit Map.',
              'keepout'
            )}
          </span>
        </label>

        <label className="pf-toggle">
          <input
            type="checkbox"
            checked={useSpeed}
            disabled={!selectedMap?.speed_painted}
            onChange={(e) => setUseSpeed(e.target.checked)}
          />
          <span className="pf-toggle__label">Speed filter</span>
          <span className="pf-toggle__help">
            {filterHelp(
              selectedMap?.speed_painted,
              selectedMap?.has_speed,
              'Slow the robot down in the areas you painted in Edit Map.',
              'speed'
            )}
          </span>
        </label>
      </PreflightScreen>
    );
  }

  return (
    <>
      <aside className="ctrl-panel">
        <div className="ctrl-panel__head">
          <h2 className="ctrl-panel__title">Navigation</h2>
          <p className="cp-sub">Map: {mapName || '—'}</p>
          {filtersNote && <p className="cp-sub">{filtersNote}</p>}
          {startedUnchecked && (
            <p className="cp-warn" role="status">
              Started without the robot checks. Use Actions in the top bar to home or stow.
            </p>
          )}
          {notice && <p className="cp-flash" role="status">{notice}</p>}
        </div>

        <div className="ctrl-panel__body">
          <ul className="cp-health" aria-label="Robot systems">
            {HEALTH.map((h) => (
              <li key={h.key} className="cp-health__item" data-state={h.state} title={h.title}>
                <span className="cp-health__dot" aria-hidden="true" />
                {h.label}
              </li>
            ))}
          </ul>
          {healthIssue && (
            <p className="cp-hint" role="status">
              {healthIssue.label}: {healthIssue.title}
            </p>
          )}

          <section className="cp-sect">
            <h3 className="cp-sect__title">Map tools</h3>
            <p className="cp-hint">Nothing here moves the robot.</p>
            <div className="seg" role="radiogroup" aria-label="Map click tool" ref={segRef} onKeyDown={onSegKey}>
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  className={`seg__btn${pulseSetPose && t.id === 'initial' ? ' seg__btn--pulse' : ''}`}
                  data-tool={t.id}
                  aria-checked={clickMode === t.id}
                  tabIndex={(TOOLS.some((x) => x.id === clickMode) ? clickMode : 'view') === t.id ? 0 : -1}
                  title={t.title}
                  onClick={() => selectClickMode(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="cp-hint">{TOOL_HINT[clickMode] ?? TOOL_HINT.view}</p>
          </section>

          <section className="cp-sect cp-sect--moves">
            <h3 className="cp-sect__title">Goal</h3>
            <p className="cp-hint">These move the robot.</p>
            <div className="cp-cmds cp-cmds--split">
              <button
                type="button"
                className={`btn ${clickMode === 'goal' ? 'selected' : ''}`}
                aria-pressed={clickMode === 'goal'}
                title="Arm the map: click-drag a destination and the robot drives there."
                onClick={() => selectClickMode('goal')}
              >
                Set goal
              </button>
              <button
                type="button"
                className="btn danger"
                title="Stop the robot and drop the current goal."
                onClick={cancelGoal}
              >
                Cancel goal
              </button>
            </div>
            {goalFeedback && (
              <p className="cp-goal-status" data-state={goalFeedback} role="status">
                {GOAL_FEEDBACK[goalFeedback]}
              </p>
            )}
            <p className="cp-hint">
              {clickMode === 'goal'
                ? 'Click-drag on the map to set the goal position + direction.'
                : 'Pick Set goal, then click-drag a destination on the map.'}
            </p>
          </section>

          <section className="cp-sect cp-sect--moves">
            <div className="cp-sect__head">
              <h3 className="cp-sect__title">Charging dock</h3>
              {readiness?.plugged_in != null && (
                <span className="cp-sect__count">
                  {readiness.plugged_in
                    ? `On the dock${readiness.charging ? ' · charging' : ''}`
                    : 'Off the dock'}
                </span>
              )}
            </div>
            <div className="cp-cmds cp-cmds--split">
              <button
                type="button"
                className="btn"
                disabled={!dock || dockActive || dockRequesting}
                title={
                  dock
                    ? 'Drive to the marked dock, line up and dock to charge.'
                    : 'Mark the dock on the map first.'
                }
                onClick={() => runDockAction('dock')}
              >
                {dockActive && dockTask?.action === 'dock' ? 'Docking…' : 'Dock'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={dockActive || dockRequesting || readiness?.plugged_in === false}
                title={
                  readiness?.plugged_in === false
                    ? 'The robot is not on the dock.'
                    : 'Slide the robot off its charging dock.'
                }
                onClick={() => runDockAction('undock')}
              >
                {dockActive && dockTask?.action === 'undock' ? 'Undocking…' : 'Undock'}
              </button>
            </div>
            {dockActive && (
              <button
                type="button"
                className="btn danger block"
                title="Stop the robot and give up on docking."
                onClick={cancelGoal}
              >
                Stop {dockTask?.action === 'undock' ? 'undocking' : 'docking'}
              </button>
            )}
            {dockTask && dockTask.state !== 'idle' && dockStatusText(dockTask) && (
              <p
                className="cp-goal-status"
                data-state={DOCK_STATUS_LOOK[dockTask.state]}
                role="status"
              >
                {dockStatusText(dockTask)}
              </p>
            )}
            <p className="cp-hint">
              {dock
                ? 'Dock drives to the dock and lines up on its own. Undock before sending the robot anywhere.'
                : 'Mark where the dock is on the map to enable Dock.'}
            </p>

            <div className="cp-cmds cp-cmds--split">
              <button
                type="button"
                className={`btn ${findOpen ? 'selected' : ''}`}
                title="Park the robot near the dock and let it find the dock for you."
                onClick={openFindDock}
              >
                Find dock
              </button>
              <button
                type="button"
                className={`btn ${placingDock ? 'selected' : ''}`}
                title="Click-drag on the map where the dock stands."
                onClick={startPlaceDock}
              >
                {dock ? 'Move dock' : '＋ Mark dock'}
              </button>
            </div>
            {dock?.source === 'map' && !findOpen && !placingDock && (
              <button
                type="button"
                className="btn quiet"
                title="Remove the dock from this map."
                onClick={removeDock}
              >
                Remove dock
              </button>
            )}
            {findOpen && (
              <div className="cp-form">
                {discovery?.found ? (
                  <>
                    <p className="cp-hint">
                      Found the dock — it is shown on the map. Keep it as this map&apos;s dock?
                    </p>
                    <div className="cp-form__actions">
                      <button type="button" className="btn primary" onClick={keepFoundDock}>
                        Save dock
                      </button>
                      <button type="button" className="btn quiet" onClick={startDiscovery}>
                        Look again
                      </button>
                      <button type="button" className="btn quiet" onClick={closeFindDock}>
                        Discard
                      </button>
                    </div>
                  </>
                ) : discovering ? (
                  <>
                    <p className="cp-goal-status" data-state="driving" role="status">
                      Looking for the dock… {Math.round(discovery.elapsed ?? 0)}s
                    </p>
                    <p className="cp-hint">
                      {(discovery.elapsed ?? 0) < 45
                        ? 'The head camera takes about 30 seconds to start.'
                        : 'Not found yet. Check the robot is about 1 m from the dock, facing it, with the tags on the dock in view.'}
                    </p>
                    <div className="cp-form__actions">
                      <button type="button" className="btn quiet" onClick={closeFindDock}>Stop</button>
                    </div>
                  </>
                ) : (
                  <>
                    <ol className="cp-steps">
                      <li>Park the robot about 1 m from the dock, facing it.</li>
                      <li>
                        {localized ? (
                          'The robot is localized. If its spot on the map looks wrong, use Set pose again.'
                        ) : (
                          <>
                            Tell the robot where it is:{' '}
                            <button
                              type="button"
                              className="btn quiet"
                              onClick={() => setClickMode('initial')}
                            >
                              Set pose
                            </button>
                          </>
                        )}
                      </li>
                      <li>Press Start. The robot doesn&apos;t move; it looks with its lidar and head camera.</li>
                    </ol>
                    {discovery?.error && (
                      <p className="cp-goal-status" data-state="failed" role="status">
                        {discovery.error}
                      </p>
                    )}
                    <div className="cp-form__actions">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!localized}
                        title={localized ? '' : 'Set the robot\'s pose on the map first.'}
                        onClick={startDiscovery}
                      >
                        Start
                      </button>
                      <button type="button" className="btn quiet" onClick={closeFindDock}>Cancel</button>
                    </div>
                  </>
                )}
              </div>
            )}
            {dock?.source === 'discovered' && !placingDock && (
              <p className="cp-hint">Found by discover_dock. Move it to save it with this map.</p>
            )}
            {placingDock && (
              <div className="cp-form">
                <p className="cp-hint">
                  {pendingDock
                    ? 'Adjust by click-dragging again, then Save.'
                    : 'Click on the map where the dock stands, then drag out from the wall, the way the dock faces.'}
                </p>
                <div className="cp-form__actions">
                  <button type="button" className="btn primary" disabled={!pendingDock} onClick={saveDock}>
                    Save dock
                  </button>
                  <button type="button" className="btn quiet" onClick={cancelPlaceDock}>Cancel</button>
                </div>
              </div>
            )}
          </section>

          <section className="cp-sect">
            <div className="cp-sect__head">
              <h3 className="cp-sect__title">Places</h3>
              <span className="cp-sect__count">{locations.length} saved</span>
            </div>
            <p className="cp-hint">Click a place to send the robot there.</p>
            <div className="cp-cmds cp-cmds--split">
              <button
                type="button"
                className="btn"
                title="Save where the robot is standing right now."
                onClick={openRobotForm}
              >
                ＋ Robot&apos;s spot
              </button>
              <button
                type="button"
                className={`btn ${placing ? 'selected' : ''}`}
                title="Pick a spot on the map and save it."
                onClick={startPlaceOnMap}
              >
                ＋ Place on map
              </button>
            </div>

            {robotFormOpen && (
              <div className="cp-form">
                <label className="cp-form__label" htmlFor="cp-robot-name">Name this place</label>
                <input
                  id="cp-robot-name"
                  autoFocus
                  placeholder="e.g. Kitchen"
                  value={robotName}
                  onChange={(e) => setRobotName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRobotLocation();
                    if (e.key === 'Escape') setRobotFormOpen(false);
                  }}
                />
                <div className="cp-form__actions">
                  <button type="button" className="btn primary" onClick={saveRobotLocation}>Save</button>
                  <button type="button" className="btn quiet" onClick={() => setRobotFormOpen(false)}>Cancel</button>
                </div>
              </div>
            )}

            {placing && (
              <div className="cp-form">
                <p className="cp-hint">
                  {pendingLocation
                    ? 'Adjust by click-dragging again, then name it and Save.'
                    : 'Click-drag on the map to drop the place and set its facing.'}
                </p>
                <label className="cp-form__label" htmlFor="cp-place-name">Name this place</label>
                <input
                  id="cp-place-name"
                  autoFocus
                  placeholder="e.g. Kitchen"
                  value={pendingName}
                  disabled={!pendingLocation}
                  onChange={(e) => setPendingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePlacedLocation();
                    if (e.key === 'Escape') cancelPlace();
                  }}
                />
                <div className="cp-form__actions">
                  <button type="button" className="btn primary" disabled={!pendingLocation} onClick={savePlacedLocation}>
                    Save
                  </button>
                  <button type="button" className="btn quiet" onClick={cancelPlace}>Cancel</button>
                </div>
              </div>
            )}

            <div className="goto-list">
              {locations.length === 0 && (
                <p className="cp-empty">No places yet. Send the robot somewhere, then save the spot.</p>
              )}
              {locations.map((loc) => (
                <div key={loc.id} className="goto-item">
                  <button
                    type="button"
                    className="goto-item__go"
                    onClick={() => sendGoal({ x: loc.x, y: loc.y, yaw: loc.yaw })}
                    title={`Send robot to ${loc.name}`}
                  >
                    <span className="goto-item__icon" aria-hidden="true">▶</span>
                    <span className="goto-item__name">{loc.name}</span>
                  </button>
                  <button
                    type="button"
                    className="goto-item__del"
                    title="Delete location"
                    aria-label={`Delete ${loc.name}`}
                    onClick={() => persistLocations(locations.filter((l) => l.id !== loc.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>

          <details className="cp-layers" open>
            <summary className="cp-layers__sum" title="The same overlays RViz calls displays.">
              <span className="cp-sect__title">Layers</span>
              <span className="cp-sect__count">{shownLayers} of {LAYERS.length} shown</span>
            </summary>
            <p className="cp-hint">Only changes what you see. Nothing is sent to the robot.</p>
            <div className="cp-layers__list">
              {LAYERS.map((l) => (
                <label key={l.key} title={l.title}>
                  <input
                    type="checkbox"
                    checked={layerShown[l.key]}
                    onChange={(e) => setLayer[l.key](e.target.checked)}
                  />
                  {l.label}
                </label>
              ))}
            </div>
          </details>
        </div>

        <div className="ctrl-panel__foot">
          <button
            type="button"
            className="btn danger block"
            onClick={stopNav}
            title="Shut down Nav2 and go back to the setup screen."
          >
            Stop navigation
          </button>
        </div>
      </aside>
      <div className="viewer-wrap">
        <MapViewer
          grid={mapMsg}
          globalCostmap={globalCostmap}
          localCostmap={localCostmap}
          keepoutMask={keepoutMask}
          speedMask={speedMask}
          localCostmapPose={localCostmapPose}
          footprintPose={footprintPose}
          scanPoints={scanPoints}
          plan={plan}
          footprint={footprint}
          robotPose={robotPose}
          goalPose={goalPose}
          urdfRobot={urdfRobot}
          jointStates={jointStates}
          showMap={showMap}
          showScan={showScan}
          showRobot={showRobot}
          showGlobalCostmap={showGlobalCostmap}
          showLocalCostmap={showLocalCostmap}
          showKeepoutMask={showKeepoutMask}
          showSpeedMask={showSpeedMask}
          showPlan={showPlan}
          showFootprint={showFootprint}
          clickMode={clickMode}
          onPose={onPose}
          locations={locations}
          pendingLocation={pendingLocation}
          dock={dock}
          pendingDock={pendingDock}
          dockModel={dockModel}
          showDock={showDock}
          initialPoseMarker={initialPoseMarker}
        />
        {!localized && (driverHealth === 'ok' || lidarHealth === 'ok') && !poseCardDismissed &&
          (clickMode === 'initial' ? (
            // Armed: shrink to a pill at the top so the map stays clickable.
            <div className="pose-card pose-card--pill" role="status">
              Click-drag on the map where the robot really stands — the drag sets its facing.
            </div>
          ) : (
            <div className="pose-card" role="dialog" aria-label="Tell the robot where it is">
              <button
                type="button"
                className="pose-card__close"
                aria-label="Dismiss"
                title="Dismiss — Set pose stays available under Map tools."
                onClick={dismissPoseCard}
              >
                ×
              </button>
              <h3 className="pose-card__title">Tell the robot where it is</h3>
              <p className="pose-card__body">
                The map and the real robot are not linked yet. To connect them:
              </p>
              <ol className="pose-card__steps">
                <li>Press the button below</li>
                <li>Click the map where the robot really stands</li>
                <li>Drag toward where it faces, then release</li>
              </ol>
              <button type="button" className="btn primary" onClick={() => selectClickMode('initial')}>
                Set pose
              </button>
              <p className="pose-card__later">
                Later, if the robot ever looks lost, use <b>Set pose</b> under “Map tools” in the
                left panel.
              </p>
            </div>
          ))}
        <CameraPanel rosbridgeUrl={rosbridgeUrl} onError={onError} />
      </div>
    </>
  );
}
