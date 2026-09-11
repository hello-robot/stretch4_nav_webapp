/** TF buffer and pose helpers for Stretch4 Nav Webapp map overlays. */

export function yawFromPose(pose) {
  const q = pose?.orientation;
  if (!q) return 0;
  const x = q.x ?? 0;
  const y = q.y ?? 0;
  const z = q.z ?? 0;
  const w = q.w ?? 1;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export function orientationFromYaw(yaw) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

export function normalizeFrameId(frameId) {
  return (frameId ?? '').replace(/^\//, '');
}

function poseFromTransform(transform) {
  return {
    position: transform.transform?.translation,
    orientation: transform.transform?.rotation,
  };
}

export function updateTfBuffer(buffer, message) {
  let updated = false;
  for (const transform of message?.transforms ?? []) {
    const child = normalizeFrameId(transform.child_frame_id);
    const parent = normalizeFrameId(transform.header?.frame_id);
    if (!child || !parent || !transform.transform) continue;
    buffer.set(child, transform);
    updated = true;
  }
  return updated;
}

export function tfBufferToMessage(buffer) {
  return { transforms: Array.from(buffer.values()) };
}

/**
 * Resolve all frames into map-root poses (2D yaw composition).
 * @returns {Map<string, {position, orientation}>}
 */
export function resolveTfPoses(tf, rootFrame = 'map') {
  const transforms = tf?.transforms ?? [];
  const edges = new Map();
  transforms.forEach((transform) => {
    const child = normalizeFrameId(transform.child_frame_id);
    const parent = normalizeFrameId(transform.header?.frame_id);
    if (!child || !parent || !transform.transform) return;
    edges.set(child, transform);
  });

  const resolved = new Map([
    [rootFrame, { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }],
  ]);

  const resolveFrame = (frame, visiting = new Set()) => {
    if (resolved.has(frame)) return resolved.get(frame);
    if (visiting.has(frame)) return null;
    const edge = edges.get(frame);
    if (!edge) return null;
    const parent = normalizeFrameId(edge.header?.frame_id);
    visiting.add(frame);
    const parentPose = resolveFrame(parent, visiting);
    visiting.delete(frame);
    if (!parentPose) return null;

    const localPose = poseFromTransform(edge);
    const parentYaw = yawFromPose(parentPose);
    const localYaw = yawFromPose(localPose);
    const tx = Number(localPose.position?.x ?? 0);
    const ty = Number(localPose.position?.y ?? 0);
    const x = Number(parentPose.position?.x ?? 0) + Math.cos(parentYaw) * tx - Math.sin(parentYaw) * ty;
    const y = Number(parentPose.position?.y ?? 0) + Math.sin(parentYaw) * tx + Math.cos(parentYaw) * ty;
    const pose = {
      position: { x, y, z: Number(localPose.position?.z ?? 0) },
      orientation: orientationFromYaw(parentYaw + localYaw),
    };
    resolved.set(frame, pose);
    return pose;
  };

  for (const frame of edges.keys()) {
    resolveFrame(frame);
  }
  return resolved;
}

export function lookupPose(tf, frame, rootFrame = 'map') {
  const poses = resolveTfPoses(tf, rootFrame);
  return poses.get(normalizeFrameId(frame)) ?? null;
}

export function poseToXYYaw(pose) {
  if (!pose) return null;
  return {
    x: Number(pose.position?.x ?? 0),
    y: Number(pose.position?.y ?? 0),
    yaw: yawFromPose(pose),
  };
}

/** Prefer base_footprint, then base_link. */
export function robotPoseFromTf(tf, rootFrame = 'map') {
  return (
    poseToXYYaw(lookupPose(tf, 'base_footprint', rootFrame))
    || poseToXYYaw(lookupPose(tf, 'base_link', rootFrame))
  );
}

/**
 * Project LaserScan ranges into map frame using laser pose.
 * @returns {Float32Array} flat [x0,y0,z0, x1,y1,z1, ...]
 */
export function scanPointsInMap(scan, laserPose, { stride = 2, z = 0.05 } = {}) {
  if (!scan?.ranges?.length || !laserPose) return new Float32Array(0);
  const lx = Number(laserPose.position?.x ?? 0);
  const ly = Number(laserPose.position?.y ?? 0);
  const yaw = yawFromPose(laserPose);
  const min = Number(scan.range_min ?? 0.05);
  const max = Number(scan.range_max ?? 25);
  const hasFiniteMax = Number.isFinite(max) && max > 0;
  const angleMin = Number(scan.angle_min ?? 0);
  const inc = Number(scan.angle_increment ?? 0);
  const out = [];
  for (let i = 0; i < scan.ranges.length; i += stride) {
    const r = Number(scan.ranges[i]);
    if (!Number.isFinite(r) || r < min || (hasFiniteMax && r >= max)) continue;
    const a = yaw + angleMin + inc * i;
    out.push(lx + Math.cos(a) * r, ly + Math.sin(a) * r, z);
  }
  return new Float32Array(out);
}
