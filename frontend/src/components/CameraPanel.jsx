import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useRosTopic } from '../hooks/useRosTopic';

/**
 * On-demand head-camera view (right Luxonis camera), floating over the map
 * viewer.
 *
 * The camera stack does NOT run with the mode — it costs USB bandwidth and CPU
 * on the robot — so nothing happens until the user presses the button. Start
 * launches the luxonis driver on the backend, then we subscribe to the
 * driver's own compressed subtopic over rosbridge — it JPEG-encodes lazily,
 * only while someone subscribes, so no republish node is needed. Throttled
 * server-side to ~5 fps so WiFi survives, then painted onto a canvas rotated
 * upright (the head cameras are mounted sideways).
 *
 * Three visual states:
 *   button  — camera off, one "Camera" button in the corner;
 *   open    — live panel with a "−" (minimize) and "✕" (stop) in the header;
 *   minimized — a slim pill; "+" expands back. The camera keeps running but we
 *   unsubscribe, so a hidden panel costs no bandwidth.
 */
export default function CameraPanel({ rosbridgeUrl, onError }) {
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [cam, setCam] = useState(null); // {topic, rotate_deg} from the backend
  const [hasFrame, setHasFrame] = useState(false);
  const canvasRef = useRef(null);

  // The camera may already be up (panel remounts when a mode restarts).
  useEffect(() => {
    let cancelled = false;
    api('/api/camera/status')
      .then((s) => {
        if (cancelled) return;
        setCam(s);
        setRunning(!!s.running);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const start = async () => {
    setStarting(true);
    try {
      const s = await api('/api/camera/start', { method: 'POST', body: '{}' });
      setCam(s);
      setRunning(true);
      setMinimized(false);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    setRunning(false);
    setHasFrame(false);
    try {
      await api('/api/camera/stop', { method: 'POST', body: '{}' });
    } catch (err) {
      onError?.(err.message);
    }
  };

  const { data: frame } = useRosTopic(
    rosbridgeUrl,
    cam?.topic || '',
    'sensor_msgs/CompressedImage',
    // A freshly launched camera can take >30s before the first frame; keep
    // renegotiating the subscription until it flows.
    { enabled: running && !minimized, serverThrottleMs: 200, maxResubscribes: 30 }
  );

  useEffect(() => {
    if (!frame?.data) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rot = (((cam?.rotate_deg ?? 0) % 360) + 360) % 360;
      const swap = rot === 90 || rot === 270;
      canvas.width = swap ? img.height : img.width;
      canvas.height = swap ? img.width : img.height;
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      ctx.restore();
      setHasFrame(true);
    };
    const kind = (frame.format || '').includes('png') ? 'png' : 'jpeg';
    img.src = `data:image/${kind};base64,${frame.data}`;
  }, [frame, cam]);

  if (!running) {
    return (
      <button
        type="button"
        className="cam-fab"
        disabled={starting}
        title="Start the right head camera and show its live view."
        onClick={start}
      >
        {starting ? <span className="spinner" /> : <CamIcon />}
        {starting ? 'Starting camera…' : 'Camera'}
      </button>
    );
  }

  if (minimized) {
    return (
      <div className="cam-panel cam-panel--min">
        <span className="cam-panel__title">
          <span className="dot on" /> Camera on
        </span>
        <button
          type="button"
          className="cam-panel__btn"
          title="Expand the camera view"
          aria-label="Expand camera view"
          onClick={() => setMinimized(false)}
        >
          ＋
        </button>
        <button
          type="button"
          className="cam-panel__btn"
          title="Stop the camera"
          aria-label="Stop camera"
          onClick={stop}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="cam-panel">
      <div className="cam-panel__head">
        <span className="cam-panel__title">
          <span className={`dot ${hasFrame ? 'on' : 'unknown'}`} /> {cam?.label || 'Camera'}
        </span>
        <button
          type="button"
          className="cam-panel__btn"
          title="Minimize — the camera keeps running"
          aria-label="Minimize camera view"
          onClick={() => setMinimized(true)}
        >
          −
        </button>
        <button
          type="button"
          className="cam-panel__btn"
          title="Stop the camera"
          aria-label="Stop camera"
          onClick={stop}
        >
          ✕
        </button>
      </div>
      <div className="cam-panel__view">
        <canvas ref={canvasRef} />
        {!hasFrame && (
          <div className="cam-panel__wait">
            <span className="spinner" />
            <span>Waiting for video… the camera takes a moment to start.</span>
            <span className="cam-panel__topic">{cam?.topic}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CamIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m16 10 6-3v10l-6-3" />
    </svg>
  );
}
