import { useCallback, useEffect, useRef, useState } from 'react';
import ROSLIB from 'roslib';
import rosConnectionManager from '../ros/rosConnectionManager';

/**
 * Manual base drive pad, floating over the map viewer (Mapping and Navigation).
 *
 * Arrows move the base forward / back / sideways and two buttons rotate it. Motion 
 * is hold-to-move: a Twist is streamed at 20 Hz while a button is pressed, and a zero 
 * Twist is sent the moment it is released — or the pointer leaves, the window loses
 * focus, the panel is collapsed, or the robot is runstopped.
 *
 * Twists go to /cmd_vel_nav, so the collision monitor still stops the base in 
 * front of obstacles. Speeds are deliberately gentle; the collision monitor
 * and driver clamp them further.
 */
const CMD_TOPIC = '/cmd_vel_nav';
const PUBLISH_HZ = 20;

const SPEEDS = {
  slow: { label: 'Slow', lin: 0.05, ang: 0.15 },
  medium: { label: 'Medium', lin: 0.12, ang: 0.35 },
  fast: { label: 'Fast', lin: 0.2, ang: 0.6 },
};

// [label, title, linear x, linear y, angular z]  (ROS: +x forward, +y left, +z counter-clockwise)
const PAD = {
  forward: ['▲', 'Forward', 1, 0, 0],
  back: ['▼', 'Backward', -1, 0, 0],
  left: ['◀', 'Slide left', 0, 1, 0],
  right: ['▶', 'Slide right', 0, -1, 0],
  ccw: ['↺', 'Rotate counter-clockwise', 0, 0, 1],
  cw: ['↻', 'Rotate clockwise', 0, 0, -1],
};

export default function DrivePanel({ rosbridgeUrl, disabled = false, onError }) {
  const [minimized, setMinimized] = useState(true);
  const [speed, setSpeed] = useState('medium');
  const [active, setActive] = useState(null); // key of the pad button held down
  const topicRef = useRef(null);
  const timerRef = useRef(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const publish = useCallback((x, y, z) => {
    topicRef.current?.publish(
      new ROSLIB.Message({
        linear: { x, y, z: 0 },
        angular: { x: 0, y: 0, z },
      })
    );
  }, []);

  const halt = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setActive(null);
    publish(0, 0, 0);
  }, [publish]);

  // Hold the topic open while the pad is showing.
  const showing = !minimized;
  useEffect(() => {
    if (!showing || !rosbridgeUrl) return undefined;
    let cancelled = false;
    rosConnectionManager
      .getConnection(rosbridgeUrl)
      .then((ros) => {
        if (cancelled) return;
        const t = new ROSLIB.Topic({ ros, name: CMD_TOPIC, messageType: 'geometry_msgs/Twist' });
        t.advertise();
        topicRef.current = t;
      })
      .catch((err) => onError?.(`Drive: ${err.message || err}`));
    return () => {
      cancelled = true;
      halt();
      const t = topicRef.current;
      topicRef.current = null;
      if (t) {
        try {
          t.unadvertise();
        } catch {
          /* ignore */
        }
      }
    };
  }, [showing, rosbridgeUrl, halt, onError]);

  // Never leave the base moving if the user tabs away or the robot is stopped.
  useEffect(() => {
    window.addEventListener('blur', halt);
    return () => window.removeEventListener('blur', halt);
  }, [halt]);
  useEffect(() => {
    if (disabled) halt();
  }, [disabled, halt]);

  const press = (key) => (e) => {
    if (disabled || !topicRef.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [, , fx, fy, fz] = PAD[key];
    if (timerRef.current) clearInterval(timerRef.current);
    const send = () => {
      const s = SPEEDS[speedRef.current];
      publish(fx * s.lin, fy * s.lin, fz * s.ang);
    };
    send();
    timerRef.current = setInterval(send, 1000 / PUBLISH_HZ);
    setActive(key);
  };

  const padButton = (key, className) => {
    const [glyph, title] = PAD[key];
    return (
      <button
        type="button"
        key={key}
        className={`drive-pad__btn ${className} ${active === key ? 'is-active' : ''}`}
        title={title}
        aria-label={title}
        disabled={disabled}
        onPointerDown={press(key)}
        onPointerUp={halt}
        onPointerCancel={halt}
        onLostPointerCapture={halt}
        onContextMenu={(e) => e.preventDefault()}
      >
        {glyph}
      </button>
    );
  };

  if (minimized) {
    return (
      <div className="drive-panel drive-panel--min">
        <span className="drive-panel__title">Drive</span>
        <button
          type="button"
          className="cam-panel__btn"
          title="Expand the drive pad"
          aria-label="Expand drive pad"
          onClick={() => setMinimized(false)}
        >
          ＋
        </button>
      </div>
    );
  }

  return (
    <div className="drive-panel">
      <div className="cam-panel__head">
        <span className="drive-panel__title">Drive base</span>
        <button
          type="button"
          className="cam-panel__btn"
          title="Minimize — the robot stops"
          aria-label="Minimize drive pad"
          onClick={() => setMinimized(true)}
        >
          −
        </button>
      </div>
      <div className="drive-pad">
        {padButton('ccw', 'drive-pad__ccw')}
        {padButton('forward', 'drive-pad__fwd')}
        {padButton('cw', 'drive-pad__cw')}
        {padButton('left', 'drive-pad__left')}
        {padButton('right', 'drive-pad__right')}
        {padButton('back', 'drive-pad__back')}
      </div>
      <div className="drive-panel__speed" role="group" aria-label="Speed">
        {Object.entries(SPEEDS).map(([id, s]) => (
          <button
            key={id}
            type="button"
            className={speed === id ? 'is-on' : ''}
            onClick={() => setSpeed(id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="drive-panel__hint">
        {disabled
          ? 'Robot is stopped (runstop) — release it to drive.'
          : 'Hold a button to move; release to stop. Obstacle stopping stays on.'}
      </p>
    </div>
  );
}

function DriveIcon() {
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
      <path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" />
    </svg>
  );
}
