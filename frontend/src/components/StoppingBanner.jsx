/**
 * Top-centre notice while a mode is shutting down. Stopping Nav2 / SLAM can take
 * 15+ seconds, and the robot's drivers are still releasing hardware.
 */
export default function StoppingBanner({ mode }) {
  const name = mode === 'mode' ? 'the robot' : mode.replace('_', ' ');
  return (
    <div className="stopping-banner" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="stopping-banner__text">
        <b>Stopping {name}…</b> This can take up to 30 seconds.
      </span>
    </div>
  );
}
