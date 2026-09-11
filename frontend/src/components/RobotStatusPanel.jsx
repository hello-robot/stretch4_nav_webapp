import { useCallback, useEffect, useRef } from 'react';

/**
 * The topbar "Robot status" chip and its panel.
 *
 * Two things only: how full the battery is and whether the robot is stopped.
 */

function BatteryIcon({ pct, charging }) {
  const level = pct == null ? null : Math.max(0, Math.min(100, pct));
  const fill = level == null ? 0 : (level / 100) * 13;
  const tone =
    level == null ? 'var(--text-muted)' : level <= 20 ? 'var(--danger)' : level <= 40 ? 'var(--warn)' : 'var(--ok)';

  return (
    <svg width="24" height="14" viewBox="0 0 24 14" aria-hidden="true" focusable="false">
      <rect x="0.75" y="0.75" width="19.5" height="12.5" rx="2.5" fill="none" stroke="var(--border)" strokeWidth="1.5" />
      <path d="M22 4.5v5a2.5 2.5 0 0 0 0-5z" fill="var(--border)" />
      {level != null && <rect x="3" y="3" width={fill} height="8" rx="1" fill={charging ? 'var(--ok)' : tone} />}
      {charging && (
        <path d="M11.6 2.4 7.4 8h3.1l-1 4.2L14 6.4h-3.2l0.8-4z" fill="var(--bg)" stroke="var(--ok)" strokeWidth="1" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export default function RobotStatusPanel({ readiness, runstop, open, onOpenChange, onRefresh }) {
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);

  const known = !!readiness;
  const reachable = readiness?.server_ok === true;
  const soc = readiness?.battery_soc ?? null;
  const charging = readiness?.charging === true;
  const pluggedIn = readiness?.plugged_in === true;
  const lowBattery = readiness?.low_battery === true;
  const engaged = runstop.engaged;
  const age = readiness?.reading_age;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Capture phase, matching ActionsMenu: the map canvas swallows pointerdown
  // while a click-tool is armed, so a bubble listener would never fire and the
  // panel would stay pinned open over the map.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    }
  };

  const chipState = !known
    ? 'unknown'
    : !reachable
      ? 'off'
      : engaged === true || lowBattery
        ? 'warn'
        : 'on';

  const chipSummary = !known
    ? 'Checking the robot…'
    : !reachable
      ? 'The robot is not answering'
      : engaged === true
        ? 'Stopped — runstop is on'
        : lowBattery
          ? 'Battery is low'
          : 'Ready to move';

  const batteryText = soc == null ? '—' : `${Math.round(soc)}%`;
  const powerNote = charging
    ? 'Charging'
    : pluggedIn
      ? 'Plugged in, not charging'
      : 'Running on battery';

  return (
    <div className="menu rs" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="rs__chip"
        data-state={chipState}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="robot-status-panel"
        title={`Robot status — ${chipSummary}`}
        onClick={() => onOpenChange(!open)}
      >
        <BatteryIcon pct={soc} charging={charging} />
        <span className="rs__chip-pct">{batteryText}</span>
        <span className="rs__chip-sep" aria-hidden="true" />
        <span className={`dot ${chipState}`} />
        <span className="rs__chip-state">{engaged === true ? 'Stopped' : reachable ? 'Ready' : known ? 'No link' : '…'}</span>
        <span className="menu__caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          className="menu__pop rs__pop"
          id="robot-status-panel"
          role="dialog"
          aria-label="Robot status"
          ref={popRef}
          onKeyDown={onKey}
        >
          <p className="menu__label">Robot status</p>

          {/* Runstop leads: it is the only item here that stops the robot doing
              what you asked, so it gets the whole-card treatment. */}
          <div className="rs-card" data-tone={engaged === true ? 'danger' : engaged === false ? 'ok' : 'muted'}>
            <span className="rs-card__title">
              {engaged === true ? 'Runstopped' : engaged === false ? 'Ready to move' : 'Runstop unknown'}
            </span>
            <span className="rs-card__body">
              {engaged === true
                ? 'The robot will not move until the runstop is released.'
                : engaged === false
                  ? 'The runstop is off.'
                  : 'Waiting for the robot to report in.'}
            </span>
            {engaged === true && (
              <button
                type="button"
                className="btn sm"
                disabled={runstop.pending === 'release'}
                onClick={runstop.release}
              >
                {runstop.pending === 'release' ? 'Releasing…' : 'Release runstop'}
              </button>
            )}
          </div>

          <div className="rs-battery" data-low={lowBattery ? 'true' : 'false'}>
            <div className="rs-battery__head">
              <BatteryIcon pct={soc} charging={charging} />
              <b className="rs-battery__pct">{batteryText}</b>
              <span className="rs-battery__note">{reachable ? powerNote : 'Unknown'}</span>
            </div>
            <div className="rs-battery__track" role="img" aria-label={`Battery ${batteryText}`}>
              <span
                className="rs-battery__fill"
                data-tone={soc == null ? 'unknown' : soc <= 20 ? 'low' : soc <= 40 ? 'mid' : 'ok'}
                style={{ width: soc == null ? 0 : `${Math.max(0, Math.min(100, soc))}%` }}
              />
            </div>
            {lowBattery && !charging && (
              <span className="rs-battery__warn">
                Getting low — plug the charger in. The robot stops itself if the battery runs out.
              </span>
            )}
          </div>

          {!reachable && known && (
            <p className="rs-card__hint">{readiness?.error || 'The robot is not answering.'}</p>
          )}

          <div className="rs-foot">
            <span className="rs-foot__age">
              {reachable && age != null ? `Updated ${age < 2 ? 'just now' : `${Math.round(age)}s ago`}` : 'No fresh reading'}
            </span>
            <button type="button" className="btn quiet sm" onClick={() => onRefresh?.().catch?.(() => {})}>
              Check again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
