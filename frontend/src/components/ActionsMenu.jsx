import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

/**
 * Topbar "Actions" dropdown — home / stow / start the gamepad from anywhere,
 * plus a live readout of what the robot currently reports.
 *
 * Actions fire immediately — no confirm steps, by explicit request. The only
 * things that disable an item are functional: the robot is not answering, or
 * another action is still running.
 */


const dotFor = (v) => (v === true ? 'on' : v === false ? 'warn' : 'unknown');
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
const dongleText = (v) => (v === true ? 'connected' : v === false ? 'not detected' : 'unknown');

// "stowed" compares every joint against the stow pose stretch_params declares
// for this robot's tool
const stowText = (r) => {
  if (r?.stowed === true) return 'yes';
  if (r?.stowed !== false) return r?.homed === false ? 'unknown — not homed' : 'unknown';
  const out = r.stow_offenders;
  return out?.length ? `no — ${out.join(', ')}` : 'no';
};

export default function ActionsMenu({
  readiness,
  onHome,
  onStow,
  onRefresh,
  onError,
  activeMode,
  open,
  onOpenChange,
}) {
  const [gamepadBusy, setGamepadBusy] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);

  const busy = readiness?.busy || null;
  const known = !!readiness; 
  const unreachable = known && readiness.server_ok !== true;
  const homed = readiness?.homed === true;
  const gamepadRunning = readiness?.gamepad_running === true;
  const homeDisabled = unreachable || !!busy;
  const stowDisabled = unreachable || !!busy || !homed;
  const gamepadDisabled = gamepadBusy || gamepadRunning;
  const runningMode = activeMode === 'mapping' || activeMode === 'navigation' ? activeMode : null;

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Close on a click anywhere outside the trigger + popup. Capture phase: the
  // map canvas calls stopPropagation() on pointerdown while a click-tool is
  // armed, so a bubble-phase listener would never see those clicks and the menu
  // would stay open.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  // On open: refresh the snapshot — it goes stale while polling is off.
  useEffect(() => {
    if (!open) return;
    onRefresh?.().catch?.(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the first thing you can actually press on open.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  const items = () =>
    Array.from(popRef.current?.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])') || []);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      close();
      return;
    }
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(at + 1 + list.length) % list.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at - 1 + list.length) % list.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1].focus();
    }
  };

  const doHome = async () => {
    // Homing takes ~a minute of joint motion; don't leave Nav2 driving into it.
    if (runningMode === 'navigation') {
      try {
        await api('/api/navigation/cancel', { method: 'POST', body: '{}' });
      } catch {
        /* best effort — homing is what the user asked for */
      }
    }
    try {
      await onHome();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const doStow = async () => {
    try {
      await onStow();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const doGamepad = async () => {
    setGamepadBusy(true);
    try {
      await api('/api/robot/gamepad/start', { method: 'POST', body: '{}' });
      await onRefresh?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setGamepadBusy(false);
    }
  };

  const homeLabel = busy === 'home' ? 'Homing…' : 'Home robot';
  const homeSub = unreachable
    ? 'The robot is not answering.'
    : busy === 'stow'
      ? 'Busy stowing…'
      : 'Moves every joint to find its zero. Takes about a minute.';
  const stowLabel = busy === 'stow' ? 'Stowing…' : 'Stow';
  const stowSub = unreachable
    ? 'The robot is not answering.'
    : busy === 'home'
      ? 'Busy homing…'
      : !homed
        ? 'Home the robot first.'
        : 'Pulls the arm in so the robot can drive safely.';
  const gamepadLabel = gamepadBusy
    ? 'Starting gamepad…'
    : gamepadRunning
      ? 'Gamepad running'
      : 'Start gamepad';
  const gamepadSub = gamepadRunning
    ? 'Teleop is on — drive with the controller.'
    : readiness?.dongle_connected === false
      ? 'No dongle detected — plug it in first, then start.'
      : 'Lets you drive the robot with the controller.';

  return (
    <div className="menu" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="menu__trigger"
        data-busy={busy ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="actions-menu"
        title="Robot actions — home, stow, gamepad, check status"
        onClick={() => onOpenChange(!open)}
      >
        {busy ? (
          <span className="spinner" />
        ) : (
          <span className={`dot ${!known ? 'unknown' : unreachable ? 'off' : homed ? 'on' : 'warn'}`} />
        )}
        {busy === 'home' ? 'Homing…' : busy === 'stow' ? 'Stowing…' : 'Actions'}
        <span className="menu__caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          className="menu__pop"
          id="actions-menu"
          role="menu"
          aria-label="Robot actions"
          ref={popRef}
          onKeyDown={onKey}
        >
          <p className="menu__label">Robot</p>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu__item"
            aria-disabled={homeDisabled}
            onClick={() => !homeDisabled && doHome()}
          >
            <span className="menu__item-text">
              {busy === 'home' && <span className="spinner" />}
              {homeLabel}
            </span>
            <span className="menu__item-sub">{homeSub}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu__item"
            aria-disabled={stowDisabled}
            onClick={() => !stowDisabled && doStow()}
          >
            <span className="menu__item-text">
              {busy === 'stow' && <span className="spinner" />}
              {stowLabel}
            </span>
            <span className="menu__item-sub">{stowSub}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu__item"
            aria-disabled={gamepadDisabled}
            onClick={() => !gamepadDisabled && doGamepad()}
          >
            <span className="menu__item-text">
              {gamepadBusy && <span className="spinner" />}
              {gamepadLabel}
            </span>
            <span className="menu__item-sub">{gamepadSub}</span>
          </button>
          <div className="menu__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu__item"
            onClick={() => onRefresh?.().catch?.(() => {})}
          >
            <span className="menu__item-text">Check robot again</span>
          </button>
          <div className="menu__sep" role="separator" />
          <p className="menu__label">Status</p>
          <div className="menu__status" aria-live="polite">
            <p className="menu__status-row">
              <span className={`dot ${dotFor(readiness?.homed)}`} />
              Homed<b>{yesNo(readiness?.homed)}</b>
            </p>
            <p className="menu__status-row">
              <span className={`dot ${dotFor(readiness?.stowed)}`} />
              Stowed<b>{stowText(readiness)}</b>
            </p>
            <p className="menu__status-row">
              <span className={`dot ${dotFor(readiness?.dongle_connected)}`} />
              Gamepad dongle<b>{dongleText(readiness?.dongle_connected)}</b>
            </p>
            <p className="menu__status-row">
              <span className={`dot ${dotFor(readiness?.gamepad_running)}`} />
              Gamepad teleop<b>{readiness?.gamepad_running === true ? 'running' : readiness?.gamepad_running === false ? 'not running' : 'unknown'}</b>
            </p>
            {unreachable && (
              <p className="menu__status-row">
                <span className="dot off" />
                Robot link<b>not answering</b>
              </p>
            )}
            {!known && (
              <p className="menu__status-row">
                <span className="dot unknown" />
                Robot link<b>checking…</b>
              </p>
            )}
            {readiness?.action_error && (
              <p className="menu__status-row" style={{ color: 'var(--danger)' }}>
                Last action failed: {readiness.action_error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
