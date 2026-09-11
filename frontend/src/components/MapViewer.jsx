import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyJointStates } from '../hooks/useUrdfRobot';
import { yawFromPose } from '../utils/tf';

const CLICK_DRAG_THRESHOLD_PX = 8;
const NAV2_GLOBAL_COLOR = [255, 0, 0];
const NAV2_LOCAL_COLOR = [0, 12, 255];

function normalizeGrid(grid) {
  if (!grid) return null;
  if (grid.info) {
    const { width, height, resolution, origin } = grid.info;
    if (typeof grid.data === 'string') return null;
    return {
      width,
      height,
      resolution,
      originX: origin?.position?.x ?? 0,
      originY: origin?.position?.y ?? 0,
      data: grid.data,
    };
  }
  if (grid.pixels) {
    return {
      width: grid.width,
      height: grid.height,
      resolution: grid.resolution ?? 0.05,
      originX: grid.origin?.[0] ?? 0,
      originY: grid.origin?.[1] ?? 0,
      data: grid.pixels,
    };
  }
  return null;
}

function occupancyColor(value) {
  if (value < 0) return [90, 90, 90, 255];
  if (value >= 50) return [25, 25, 28, 255];
  return [210, 210, 214, 255];
}

function costmapColor(value, baseColor) {
  if (value < 0) return [0, 0, 0, 0];
  if (value === 0) return [0, 0, 0, 0];
  if (value >= 99) return [...baseColor, 160];
  const t = value / 100;
  return [
    Math.round(255 * (1 - t) + baseColor[0] * t),
    Math.round(255 * (1 - t) + baseColor[1] * t),
    Math.round(255 * (1 - t) + baseColor[2] * t),
    Math.floor(40 + 120 * t),
  ];
}

const globalCostmapColor = (value) => costmapColor(value, NAV2_GLOBAL_COLOR);
const localCostmapColor = (value) => costmapColor(value, NAV2_LOCAL_COLOR);

// Filter masks, straight from the live topics the costmap filters subscribe
// to AND deliberately NOT re-read from the saved files, so a mismatch between
// what was painted and what navigation is actually enforcing shows up here.
// Keepout (trinary): occupied cells are the no-go zones — solid magenta.
function keepoutMaskColor(value) {
  if (value >= 50) return [208, 64, 159, 165];
  return [0, 0, 0, 0];
}

// Speed (scale): higher occupancy = stronger slow-down — amber, alpha by value.
function speedMaskColor(value) {
  if (value <= 0) return [0, 0, 0, 0];
  const t = Math.min(value, 100) / 100;
  return [230, 162, 60, Math.floor(50 + 130 * t)];
}

function makeGridTexture(g, colorFn) {
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(g.width, g.height);
  for (let i = 0; i < g.data.length && i < g.width * g.height; i++) {
    const [r, green, b, a] = colorFn(g.data[i]);
    const row = Math.floor(i / g.width);
    const col = i % g.width;
    const di = ((g.height - 1 - row) * g.width + col) * 4;
    img.data[di] = r;
    img.data[di + 1] = green;
    img.data[di + 2] = b;
    img.data[di + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGridPlane(g, colorFn, z, opacity = 1) {
  const w = g.width * g.resolution;
  const h = g.height * g.resolution;
  const tex = makeGridTexture(g, colorFn);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: opacity < 1 || colorFn !== occupancyColor,
    opacity,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(g.originX + w / 2, g.originY + h / 2, z);
  mesh.userData.isGrid = true;
  return mesh;
}

function makePoseArrow(color) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CircleGeometry(0.12, 20),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
  );
  group.add(body);
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.2, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  arrow.rotation.z = -Math.PI / 2;
  arrow.position.set(0.16, 0, 0.01);
  group.add(arrow);
  return group;
}

// Billboarded text label for location names.
function makeLabel(text) {
  const pad = 8;
  const fontPx = 44;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${fontPx}px sans-serif`;
  const tw = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = tw + pad * 2;
  canvas.height = fontPx + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPx}px sans-serif`;
  ctx.fillStyle = 'rgba(15,20,26,0.78)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(240,165,61,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = '#ffd88a';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const worldH = 0.45; // meters tall
  sprite.scale.set(worldH * (canvas.width / canvas.height), worldH, 1);
  return sprite;
}

const MODE_COLORS = { goal: 0x3ecf8e, initial: 0x3d9cf0, location: 0xf0a53d };
const INTERACTIVE_MODES = ['goal', 'initial', 'location'];

/**
 * Three.js top-down map viewer with RViz-parity overlays.
 */
export default function MapViewer({
  grid,
  globalCostmap,
  localCostmap,
  keepoutMask, // nav_msgs/OccupancyGrid from /keepout_filter_mask (map frame)
  speedMask, // nav_msgs/OccupancyGrid from /speed_filter_mask (map frame)
  scanPoints, // Float32Array xyz
  plan, // nav_msgs/Path
  footprint, // PolygonStamped
  robotPose,
  goalPose,
  urdfRobot,
  jointStates,
  showMap = true,
  showScan = true,
  showRobot = true,
  showGlobalCostmap = false,
  showLocalCostmap = false,
  showKeepoutMask = false,
  showSpeedMask = false,
  showPlan = false,
  showFootprint = false,
  showGoal = true,
  // While the map is growing (mapping), keep expanding the view to include
  // newly-mapped area — but only when it actually falls outside what's
  // currently visible, so a manual zoom-in isn't undone on every message.
  autoFit = false,
  clickMode = 'view',
  onPose,
  locations = [], // [{ id, name, x, y, yaw }] — saved goals, display only
  pendingLocation = null, // { x, y, yaw } being placed on the map
  initialPoseMarker = null, // { x, y, yaw } last set-pose, brief confirmation
  // Pose of the local costmap's frame (e.g. wheel_odom) in the map frame, so a
  // rolling odom-frame costmap is drawn where the robot actually is after AMCL
  // relocalizes. null / identity => draw at map-frame origin.
  localCostmapPose = null, // { x, y, yaw }
  footprintPose = null, // { x, y, yaw } — pose of the footprint's frame in map
  className = 'map-canvas',
}) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);

  // Init scene once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e12);

    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 500);
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 20);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    const dir = new THREE.DirectionalLight(0xffffff, 0.55);
    dir.position.set(2, 3, 10);
    scene.add(ambient, dir);

    const layers = {
      map: new THREE.Group(),
      globalCost: new THREE.Group(),
      localCost: new THREE.Group(),
      keepoutMask: new THREE.Group(),
      speedMask: new THREE.Group(),
      scan: new THREE.Group(),
      plan: new THREE.Group(),
      footprint: new THREE.Group(),
      robot: new THREE.Group(),
      locations: new THREE.Group(),
      markers: new THREE.Group(),
    };
    Object.values(layers).forEach((g) => scene.add(g));

    const goalMarker = makePoseArrow(0x3ecf8e);
    goalMarker.visible = false;
    layers.markers.add(goalMarker);

    // Live arrow shown while dragging a goal / pose / location.
    const previewArrow = makePoseArrow(0x3ecf8e);
    previewArrow.visible = false;
    layers.markers.add(previewArrow);

    // Amber marker for a location being placed but not yet saved.
    const pendingMarker = makePoseArrow(0xf0a53d);
    pendingMarker.visible = false;
    layers.markers.add(pendingMarker);

    // Blue marker briefly confirming where set-pose was applied.
    const initialMarker = makePoseArrow(0x3d9cf0);
    initialMarker.visible = false;
    layers.markers.add(initialMarker);

    const fallbackRobot = makePoseArrow(0x3d9cf0);
    layers.robot.add(fallbackRobot);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();

    const interaction = {
      down: false,
      moved: false,
      start: null,
      startPx: null,
    };

    const worldFromEvent = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(plane, hit)) {
        return { x: hit.x, y: hit.y };
      }
      return null;
    };

    const clickModeRef = { current: clickMode };
    const onPoseRef = { current: onPose };

    const applyPanButtons = (mode) => {
      if (INTERACTIVE_MODES.includes(mode)) {
        // Left click reserved for pose/goal; pan with right / middle.
        controls.mouseButtons.LEFT = null;
        controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
        controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      } else {
        controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
        controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      }
    };
    applyPanButtons(clickMode);

    const onPointerDown = (e) => {
      const mode = clickModeRef.current;
      if (!INTERACTIVE_MODES.includes(mode)) return;
      if (e.button !== 0) return; // left only
      e.preventDefault();
      e.stopPropagation();
      interaction.down = true;
      interaction.moved = false;
      interaction.startPx = { x: e.clientX, y: e.clientY };
      interaction.start = worldFromEvent(e);
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (interaction.start) {
        previewArrow.children[0].material.color.setHex(MODE_COLORS[mode] ?? 0x3ecf8e);
        previewArrow.position.set(interaction.start.x, interaction.start.y, 0.18);
        previewArrow.rotation.z = 0;
        previewArrow.visible = true;
      }
    };
    const onPointerMove = (e) => {
      if (!interaction.down) return;
      if (
        Math.hypot(e.clientX - interaction.startPx.x, e.clientY - interaction.startPx.y)
        > CLICK_DRAG_THRESHOLD_PX
      ) {
        interaction.moved = true;
      }
      if (previewArrow.visible && interaction.start && interaction.moved) {
        const cur = worldFromEvent(e);
        if (cur) {
          previewArrow.rotation.z = Math.atan2(
            cur.y - interaction.start.y,
            cur.x - interaction.start.x
          );
        }
      }
    };
    const onPointerUp = (e) => {
      if (!interaction.down) return;
      interaction.down = false;
      previewArrow.visible = false;
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const mode = clickModeRef.current;
      const cb = onPoseRef.current;
      if (!interaction.start || !cb) return;
      if (!INTERACTIVE_MODES.includes(mode)) return;
      const end = worldFromEvent(e) || interaction.start;
      let yaw = 0;
      if (interaction.moved) {
        yaw = Math.atan2(end.y - interaction.start.y, end.x - interaction.start.x);
      }
      cb({ x: interaction.start.x, y: interaction.start.y, yaw, mode });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const aspect = w / Math.max(h, 1);
      const viewSize = camera.userData.viewSize || 8;
      camera.left = (-viewSize * aspect) / 2;
      camera.right = (viewSize * aspect) / 2;
      camera.top = viewSize / 2;
      camera.bottom = -viewSize / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    camera.userData.viewSize = 10;
    onResize();
    window.addEventListener('resize', onResize);

    stateRef.current = {
      scene,
      camera,
      renderer,
      controls,
      layers,
      goalMarker,
      previewArrow,
      pendingMarker,
      initialMarker,
      fallbackRobot,
      urdfRoot: null,
      fitted: false,
      clickModeRef,
      onPoseRef,
      applyPanButtons,
    };

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stateRef.current) return;
    stateRef.current.clickModeRef.current = clickMode;
    stateRef.current.onPoseRef.current = onPose;
    stateRef.current.applyPanButtons?.(clickMode);
  }, [clickMode, onPose]);

  // Fit camera to the map's bounds — always the first time it arrives, and
  // after that only (while autoFit is on) when the map has grown past what's
  // currently in view, so it never fights a manual zoom/pan.
  useEffect(() => {
    const st = stateRef.current;
    const g = normalizeGrid(grid);
    if (!st || !g) return;

    if (st.fitted) {
      if (!autoFit) return;
      const minX = g.originX;
      const maxX = g.originX + g.width * g.resolution;
      const minY = g.originY;
      const maxY = g.originY + g.height * g.resolution;
      const zoom = st.camera.zoom || 1;
      const viewMinX = st.camera.position.x + st.camera.left / zoom;
      const viewMaxX = st.camera.position.x + st.camera.right / zoom;
      const viewMinY = st.camera.position.y + st.camera.bottom / zoom;
      const viewMaxY = st.camera.position.y + st.camera.top / zoom;
      const margin = g.resolution * 2;
      const fits =
        minX >= viewMinX - margin &&
        maxX <= viewMaxX + margin &&
        minY >= viewMinY - margin &&
        maxY <= viewMaxY + margin;
      if (fits) return;
    }

    const w = g.width * g.resolution;
    const h = g.height * g.resolution;
    const cx = g.originX + w / 2;
    const cy = g.originY + h / 2;
    const viewSize = Math.max(w, h) * 1.15;
    st.camera.userData.viewSize = viewSize;
    const aspect = st.renderer.domElement.clientWidth / Math.max(st.renderer.domElement.clientHeight, 1);
    st.camera.zoom = 1;
    st.camera.left = (-viewSize * aspect) / 2;
    st.camera.right = (viewSize * aspect) / 2;
    st.camera.top = viewSize / 2;
    st.camera.bottom = -viewSize / 2;
    st.camera.position.set(cx, cy, 20);
    st.camera.lookAt(cx, cy, 0);
    st.controls.target.set(cx, cy, 0);
    st.camera.updateProjectionMatrix();
    st.fitted = true;
  }, [grid, autoFit]);

  // Map plane
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.map;
    while (group.children.length) {
      const c = group.children.pop();
      c.geometry?.dispose?.();
      c.material?.map?.dispose?.();
      c.material?.dispose?.();
    }
    group.visible = showMap;
    const g = normalizeGrid(grid);
    if (showMap && g?.data) {
      group.add(makeGridPlane(g, occupancyColor, 0, 1));
    }
  }, [grid, showMap]);

  // Costmaps
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const rebuild = (group, src, visible, z, colorFn) => {
      while (group.children.length) {
        const c = group.children.pop();
        c.geometry?.dispose?.();
        c.material?.map?.dispose?.();
        c.material?.dispose?.();
      }
      group.visible = visible;
      const g = normalizeGrid(src);
      if (visible && g?.data) group.add(makeGridPlane(g, colorFn, z, 0.65));
    };
    rebuild(st.layers.globalCost, globalCostmap, showGlobalCostmap, 0.02, globalCostmapColor);
    rebuild(st.layers.localCost, localCostmap, showLocalCostmap, 0.04, localCostmapColor);
    // Masks sit above the costmaps
    rebuild(st.layers.keepoutMask, keepoutMask, showKeepoutMask, 0.05, keepoutMaskColor);
    rebuild(st.layers.speedMask, speedMask, showSpeedMask, 0.055, speedMaskColor);
  }, [
    globalCostmap,
    localCostmap,
    keepoutMask,
    speedMask,
    showGlobalCostmap,
    showLocalCostmap,
    showKeepoutMask,
    showSpeedMask,
  ]);

  // Place the local costmap group at its (rolling, odom-frame) pose in the map
  // frame so it tracks the robot after relocalization. Kept separate from the
  // mesh rebuild above so a high-rate TF update only moves the group, never
  // regenerates the costmap texture.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const lg = st.layers.localCost;
    if (localCostmapPose) {
      lg.position.set(localCostmapPose.x, localCostmapPose.y, 0);
      lg.rotation.z = localCostmapPose.yaw ?? 0;
    } else {
      lg.position.set(0, 0, 0);
      lg.rotation.z = 0;
    }
  }, [localCostmapPose]);

  // Scan points
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.scan;
    while (group.children.length) {
      const c = group.children.pop();
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    group.visible = showScan;
    if (!showScan || !scanPoints?.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(scanPoints, 3));
    const mat = new THREE.PointsMaterial({ color: 0xff3b30, size: 3.5, sizeAttenuation: false });
    group.add(new THREE.Points(geom, mat));
  }, [scanPoints, showScan]);

  // Plan
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.plan;
    while (group.children.length) {
      const c = group.children.pop();
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    group.visible = showPlan;
    const poses = plan?.poses;
    if (!showPlan || !poses?.length) return;
    const pts = poses.map((p) => new THREE.Vector3(p.pose.position.x, p.pose.position.y, 0.08));
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x4ea1ff })));
  }, [plan, showPlan]);

  // Footprint. nav2 publishes /local_costmap/published_footprint as an oriented
  // polygon already in the costmap's global (rolling odom) frame, so build the
  // line from the raw points and let the group transform below place it in map.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.footprint;
    while (group.children.length) {
      const c = group.children.pop();
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    group.visible = showFootprint;
    const pts = footprint?.polygon?.points;
    if (!showFootprint || !pts?.length) return;
    const local = pts.map((p) => new THREE.Vector3(p.x ?? 0, p.y ?? 0, 0.09));
    local.push(local[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(local);
    group.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffcc66 })));
  }, [footprint, showFootprint]);

  // Place the footprint group at its frame's pose in map.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const g = st.layers.footprint;
    if (footprintPose) {
      g.position.set(footprintPose.x, footprintPose.y, 0);
      g.rotation.z = footprintPose.yaw ?? 0;
    } else {
      g.position.set(0, 0, 0);
      g.rotation.z = 0;
    }
  }, [footprintPose]);

  // Goal marker
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const m = st.goalMarker;
    if (!showGoal || !goalPose) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(goalPose.x, goalPose.y, 0.1);
    m.rotation.z = goalPose.yaw ?? 0;
  }, [goalPose, showGoal]);

  // Saved location markers (display only — never clickable, for safety).
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.locations;
    while (group.children.length) {
      const c = group.children.pop();
      c.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          o.material.map?.dispose?.();
          o.material.dispose?.();
        }
      });
    }
    (locations || []).forEach((loc) => {
      const pin = makePoseArrow(0xf0a53d);
      pin.position.set(loc.x, loc.y, 0.12);
      pin.rotation.z = loc.yaw ?? 0;
      group.add(pin);
      if (loc.name) {
        const label = makeLabel(loc.name);
        label.position.set(loc.x, loc.y + 0.35, 0.25);
        group.add(label);
      }
    });
  }, [locations]);

  // Pending (being-placed) location marker.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const m = st.pendingMarker;
    if (!pendingLocation) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(pendingLocation.x, pendingLocation.y, 0.18);
    m.rotation.z = pendingLocation.yaw ?? 0;
  }, [pendingLocation]);

  // Brief set-pose confirmation marker.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const m = st.initialMarker;
    if (!initialPoseMarker) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set(initialPoseMarker.x, initialPoseMarker.y, 0.18);
    m.rotation.z = initialPoseMarker.yaw ?? 0;
  }, [initialPoseMarker]);

  // URDF robot / fallback arrow
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const group = st.layers.robot;
    group.visible = showRobot;

    if (st.urdfRoot && st.urdfRoot.parent) {
      st.urdfRoot.parent.remove(st.urdfRoot);
    }
    st.urdfRoot = null;

    if (!showRobot) return;

    if (urdfRobot) {
      st.fallbackRobot.visible = false;
      const root = urdfRobot;
      // Stretch URDF is Z-up; our scene is Z-up too
      root.rotation.set(0, 0, 0);
      group.add(root);
      st.urdfRoot = root;
    } else {
      st.fallbackRobot.visible = true;
    }
  }, [urdfRobot, showRobot]);

  // Robot pose (position + heading). Placed independently of joint state so the
  // model still tracks the robot even before joints arrive.
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !showRobot) return;
    const pose = robotPose;
    if (!pose) return;
    if (st.urdfRoot) {
      st.urdfRoot.position.set(pose.x, pose.y, 0);
      st.urdfRoot.rotation.z = pose.yaw ?? 0;
    } else if (st.fallbackRobot) {
      st.fallbackRobot.position.set(pose.x, pose.y, 0.1);
      st.fallbackRobot.rotation.z = pose.yaw ?? 0;
    }
  }, [robotPose, showRobot, urdfRobot]);

  // Joint configuration (lift/arm/wrist/gripper). Kept separate from pose so the
  // arm/wrist reflect the robot's real configuration even when the map->base TF
  // (robotPose) hasn't resolved yet — otherwise the model shows its zero pose.
  useEffect(() => {
    const st = stateRef.current;
    if (!st || !showRobot || !st.urdfRoot) return;
    applyJointStates(st.urdfRoot, jointStates);
  }, [jointStates, showRobot, urdfRobot]);

  return <div ref={mountRef} className={className} style={{ width: '100%', height: '100%' }} />;
}

export { normalizeGrid };
