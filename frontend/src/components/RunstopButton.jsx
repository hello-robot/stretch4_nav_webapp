/**
 * The topbar stop button.
 */
export default function RunstopButton({ engaged, pending, onEngage, onRelease }) {
  const engaging = pending === 'engage';
  const releasing = pending === 'release';
  const isOn = engaged === true;

  return (
    <button
      type="button"
      className="runstop-btn"
      data-engaged={isOn ? 'true' : 'false'}
      aria-pressed={isOn}
      disabled={engaging || releasing}
      onClick={isOn ? onRelease : onEngage}
      title={
        isOn
          ? 'The robot is runstopped. Click to release it.'
          : 'Runstop: halt the robot right now. Nothing will move until you release it.'
      }
    >
      <StopHandIcon />
      {engaging ? 'Stopping…' : releasing ? 'Releasing…' : isOn ? 'Robot stopped' : 'Runstop'}
    </button>
  );
}

function StopHandIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M8.5 1.5H15.5L22.5 8.5V15.5L15.5 22.5H8.5L1.5 15.5V8.5L8.5 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* Palm is centred  and the fingers/thumb are balanced to */}
      <g fill="currentColor">
        <rect x="8" y="13.6" width="8" height="6.4" rx="2.4" />
        <rect x="8.35" y="8.4" width="1.6" height="6.2" rx="0.8" />
        <rect x="10.25" y="6" width="1.6" height="8.6" rx="0.8" />
        <rect x="12.15" y="7.1" width="1.6" height="7.5" rx="0.8" />
        <rect x="14.05" y="9.6" width="1.4" height="5" rx="0.7" />
        <rect x="6.2" y="14.4" width="4.6" height="2.8" rx="1.4" transform="rotate(-20 9.4 15.8)" />
      </g>
    </svg>
  );
}
