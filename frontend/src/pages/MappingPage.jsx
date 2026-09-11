import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useRosTopic } from '../hooks/useRosTopic';
import { useUrdfRobot } from '../hooks/useUrdfRobot';
import PreflightScreen from '../components/PreflightScreen';
import MapViewer from '../components/MapViewer';
import CameraPanel from '../components/CameraPanel';
import {
  lookupPose,
  orientationFromYaw,
  robotPoseFromTf,
  scanPointsInMap,
  tfBufferToMessage,
  updateTfBuffer,
} from '../utils/tf';

const LAYERS = [
  { key: 'map', label: 'Map', title: 'The map slam_toolbox has built so far.' },
  { key: 'robot', label: 'Robot', title: 'The 3D Stretch model at its current pose.' },
  { key: 'scan', label: 'Laser scan', title: 'Live lidar hits — what the robot can see right now.' },
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

async function fetchRobotDescription() {
  try {
    const res = await api('/api/robot/description');
    return res?.urdf || '';
  } catch {
    return '';
  }
}

export default function MappingPage({
  rosbridgeUrl,
  mappingActive,
  robot,
  onStatusRefresh,
  onError,
  onBusy,
}) {
  const { readiness, refresh, home, stow } = robot;
  const [mapName, setMapName] = useState('new_map');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startedUnchecked, setStartedUnchecked] = useState(false);
  const [message, setMessage] = useState('');

  const startMapping = async ({ skipReadiness } = {}) => {
    setStarting(true);
    onBusy?.(true);
    setMessage('');
    try {
      await api('/api/modes/mapping/start', {
        method: 'POST',
        body: JSON.stringify({ skip_readiness: !!skipReadiness }),
      });
      setStartedUnchecked(!!skipReadiness);
      await onStatusRefresh?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setStarting(false);
      onBusy?.(false);
    }
  };

  const stopMapping = async () => {
    onBusy?.(true);
    try {
      await api('/api/modes/stop', { method: 'POST', body: '{}' });
      setStartedUnchecked(false);
      await onStatusRefresh?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      onBusy?.(false);
    }
  };

  const [showScan, setShowScan] = useState(true);
  const [showRobot, setShowRobot] = useState(true);
  const [showMap, setShowMap] = useState(true);
  const [urdfXml, setUrdfXml] = useState('');
  const tfBuffer = useRef(new Map());

  // CBOR for the same reason as navigation: past ~1 MB of JSON rosbridge
  // fragments the grid and roslib drops it, so a large map would stop drawing
  // partway through the session.
  const { data: mapMsg } = useRosTopic(rosbridgeUrl, '/map', 'nav_msgs/OccupancyGrid', {
    throttleMs: 400,
    compression: 'cbor',
    // Drop the cached grid when the session ends
    enabled: mappingActive,
  });
  const { data: scanFiltered } = useRosTopic(rosbridgeUrl, '/scan_filtered', 'sensor_msgs/LaserScan', {
    throttleMs: 100,
    enabled: showScan,
  });
  const { data: rawScan } = useRosTopic(rosbridgeUrl, '/scan', 'sensor_msgs/LaserScan', {
    throttleMs: 100,
    enabled: showScan,
  });
  const { data: tfDyn } = useRosTopic(rosbridgeUrl, '/tf', 'tf2_msgs/TFMessage', {
    throttleMs: 50,
  });
  const { data: tfStatic } = useRosTopic(rosbridgeUrl, '/tf_static', 'tf2_msgs/TFMessage');
  const { data: jointStates } = useRosTopic(rosbridgeUrl, '/joint_states', 'sensor_msgs/JointState', {
    throttleMs: 100,
  });
  const { data: robotDescMsg } = useRosTopic(rosbridgeUrl, '/robot_description', 'std_msgs/String');
  const { data: amcl } = useRosTopic(
    rosbridgeUrl,
    '/amcl_pose',
    'geometry_msgs/PoseWithCovarianceStamped',
    { throttleMs: 200 }
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
    () => scanPointsInMap(scan, laserPose, { stride: 2 }),
    [scan, laserPose]
  );

  const { robot: urdfRobot } = useUrdfRobot(urdfXml, showRobot);

  const saveMap = async () => {
    setSaving(true);
    onBusy?.(true);
    setMessage('');
    try {
      const res = await api('/api/mapping/save', {
        method: 'POST',
        body: JSON.stringify({ name: mapName }),
      });
      setMessage(`Saved map "${res.name}" to ${res.path}`);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setSaving(false);
      onBusy?.(false);
    }
  };

  const layerShown = { map: showMap, robot: showRobot, scan: showScan };
  const setLayer = { map: setShowMap, robot: setShowRobot, scan: setShowScan };
  const shownLayers = LAYERS.filter((l) => layerShown[l.key]).length;

  // Every hook is above this line — the preflight screen is a full-page state.
  if (!mappingActive) {
    return (
      <PreflightScreen
        mode="mapping"
        readiness={readiness}
        onHome={home}
        onStow={stow}
        onRefresh={refresh}
        onError={onError}
        starting={starting}
        blocker={null}
        onStart={startMapping}
      >
        <p className="pf-note">
          Nothing to set up. You will name and save the map when you are done.
        </p>
      </PreflightScreen>
    );
  }

  return (
    <>
      <aside className="ctrl-panel">
        <div className="ctrl-panel__head">
          <h2 className="ctrl-panel__title">Mapping</h2>
          <p className="cp-sub">
            Drive the robot around the whole space with the gamepad, then save the map.
          </p>
          {startedUnchecked && (
            <p className="cp-warn" role="status">
              Started without the robot checks. Use Actions in the top bar to home or stow.
            </p>
          )}
        </div>

        <div className="ctrl-panel__body">
          <section className="cp-sect">
            <h3 className="cp-sect__title">Save map</h3>
            <div className="cp-form">
              <label className="cp-form__label" htmlFor="cp-map-name">Map name</label>
              <input
                id="cp-map-name"
                value={mapName}
                onChange={(e) => setMapName(e.target.value)}
              />
              <div className="cp-form__actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={saving || !mapName.trim()}
                  onClick={saveMap}
                  title="Write the map slam_toolbox has built to your maps folder."
                >
                  {saving ? 'Saving…' : 'Save map'}
                </button>
              </div>
            </div>
            {message && <p className="cp-ok">{message}</p>}
          </section>

          <details className="cp-layers" open>
            <summary className="cp-layers__sum">
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
            onClick={stopMapping}
            title="Shut down slam_toolbox and go back to the setup screen."
          >
            Stop mapping
          </button>
        </div>
      </aside>
      <div className="viewer-wrap">
        <MapViewer
          grid={mapMsg}
          scanPoints={scanPoints}
          robotPose={robotPose}
          urdfRobot={urdfRobot}
          jointStates={jointStates}
          showMap={showMap}
          showScan={showScan}
          showRobot={showRobot}
          autoFit
          clickMode="view"
        />
        <CameraPanel rosbridgeUrl={rosbridgeUrl} onError={onError} />
      </div>
    </>
  );
}
