import { useState } from 'react';

/**
 * The screen you see before Mapping or Navigation starts.
 *
 * It *offers* Home / Stow rather than demanding them: the primary Start button
 * lights up once the robot reports ready, and "Start anyway without the checks"
 * is always there for the times the check isn't fine. Skipping
 * posts skip_readiness:true, which is the only thing that gets past the
 * backend's require_ready() guardrail.
 *
 * `blocker` is for a requirement Skip *cannot* satisfy (navigation with no map
 * picked); it disables both buttons and explains itself.
 */

const COPY = {
  mapping: {
    eyebrow: 'Mapping',
    label: 'Mapping',
    title: 'Before you start mapping',
    lead:
      'You drive the robot by hand with the gamepad while it builds the map. ' +
      'Check the robot below, then start.',
    start: 'Start mapping',
    checks: ['homed', 'stowed', 'dongle'],
  },
  navigation: {
    eyebrow: 'Navigation',
    label: 'Navigation',
    title: 'Before you start navigating',
    lead:
      'Pick the map for the place you are in. After it starts you need to tell the robot ' +
      'where it is, then you can send it to places.',
    start: 'Start navigation',
    checks: ['homed'],
  },
};

const WAITING = { homed: 'homing', stowed: 'stowing', dongle: 'the gamepad dongle' };

const RISK = {
  mapping: {
    homed: 'The robot is not homed — it does not know where its joints are.',
    stowed: 'The robot is not stowed — watch out for the arm and wrist while you are driving.',
    dongle: 'No gamepad dongle — you will not be able to drive, so the map will not build.',
  },
  navigation: {
    homed: 'The robot is not homed — Nav2 will drive using joint positions it has not verified.',
  },
};

function checkState(id, r) {
  if (!r || !r.server_ok) return 'unknown';
  if (r.busy === 'home' && id === 'homed') return 'busy';
  if (r.busy === 'stow' && id === 'stowed') return 'busy';
  if (id === 'stowed' && r.stowed == null) return 'unknown';
  const ok =
    id === 'homed' ? r.homed === true : id === 'stowed' ? r.stowed === true : r.dongle_connected === true;
  return ok ? 'ok' : 'todo';
}

// Joint names as they come from stretch_params.
const jointList = (names) => (names || []).map((n) => n.replace(/_/g, ' ')).join(', ');

function joinList(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function CheckRow({ state, label, why, action }) {
  return (
    <li className="pf-check" data-state={state}>
      <span className="pf-check__mark" aria-hidden="true">
        {state === 'busy' ? <span className="spinner" /> : state === 'ok' ? '✓' : state === 'todo' ? '!' : '·'}
      </span>
      <div className="pf-check__text">
        <span className="pf-check__label">{label}</span>
        {why && <p className="pf-check__why">{why}</p>}
      </div>
      {action && <div className="pf-check__action">{action}</div>}
    </li>
  );
}

export default function PreflightScreen({
  mode,
  readiness,
  onHome,
  onStow,
  onRefresh,
  onError,
  starting = false,
  blocker = null,
  onStart,
  children,
}) {
  const [skipOpen, setSkipOpen] = useState(false);
  const copy = COPY[mode];

  const checks = copy.checks.map((id) => ({ id, state: checkState(id, readiness) }));
  const passed = checks.filter((c) => c.state === 'ok').length;
  const allOk = passed === checks.length;
  const unreachable = !!readiness && readiness.server_ok === false;
  const busy = readiness?.busy || null;
  const homed = readiness?.homed === true;
  const unknownWhy = readiness ? 'The robot is not answering.' : 'Waiting for the robot to answer.';

  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const rowFor = ({ id, state }) => {
    if (id === 'homed') {
      const label =
        state === 'busy' ? 'Homing…' : state === 'ok' ? 'Homed' : state === 'todo' ? 'Not homed' : 'Homed — unknown';
      const why =
        state === 'busy'
          ? 'Every joint is moving through its range. Keep the area clear.'
          : state === 'todo'
            ? 'Homing moves every joint to find its zero. Takes about a minute.'
            : state === 'unknown'
              ? unknownWhy
              : null;
      return {
        state,
        label,
        why,
        action: (
          <button
            type="button"
            className="btn"
            disabled={!!busy || state === 'unknown'}
            onClick={() => run(onHome)}
          >
            {state === 'busy' ? 'Homing…' : state === 'ok' ? 'Re-home' : 'Home robot'}
          </button>
        ),
      };
    }
    if (id === 'stowed') {
      const offenders = jointList(readiness?.stow_offenders);
      const label =
        state === 'busy'
          ? 'Stowing…'
          : state === 'ok'
            ? 'Stowed'
            : state === 'todo'
              ? offenders
                ? `Not stowed — ${offenders}`
                : 'Not stowed'
              : 'Stowed — unknown';
      const why =
        state === 'busy'
          ? 'The arm is pulling in.'
          : state === 'todo'
            ? 'Stowing folds the arm and wrist in so nothing catches on a door frame while the robot drives.'
            : state === 'unknown'
              ? homed
                ? unknownWhy
                : 'Home the robot first.'
              : null;
      const disabled = !!busy || !homed || readiness?.server_ok !== true;
      return {
        state,
        label,
        why,
        action: (
          <button
            type="button"
            className="btn"
            disabled={disabled}
            title={!homed ? 'Home the robot first' : undefined}
            onClick={() => run(onStow)}
          >
            {state === 'busy' ? 'Stowing…' : state === 'ok' ? 'Stow again' : 'Stow arm'}
          </button>
        ),
      };
    }
    // dongle — nothing the UI can do about it, so no button.
    return {
      state,
      label:
        state === 'ok'
          ? 'Gamepad dongle connected'
          : state === 'todo'
            ? 'No gamepad dongle'
            : 'Gamepad dongle — unknown',
      why:
        state === 'todo'
          ? "Plug the gamepad's USB dongle into the robot's computer. You need it to drive while the map builds."
          : state === 'unknown'
            ? unknownWhy
            : null,
      action: null,
    };
  };

  const reason = blocker
    ? blocker
    : starting
      ? null
      : !readiness
        ? 'Checking the robot…'
        : unreachable
          ? "The robot isn't answering."
          : busy
            ? busy === 'home'
              ? 'Homing…'
              : 'Stowing…'
            : `Waiting on ${joinList(checks.filter((c) => c.state !== 'ok').map((c) => WAITING[c.id]))}.`;

  const risks = [
    ...(!readiness ? ['The robot has not answered yet — its state is unknown.'] : []),
    ...(unreachable ? ['The robot is not answering — starting will probably fail.'] : []),
    ...checks.filter((c) => c.state === 'todo').map((c) => RISK[mode][c.id]),
  ];

  return (
    <div className="viewer-wrap viewer-wrap--gate">
      <section className="pf" aria-labelledby="pf-title">
        <p className="pf__eyebrow">{copy.eyebrow}</p>
        <h1 className="pf__title" id="pf-title">
          {copy.title}
        </h1>
        <p className="pf__lead">{copy.lead}</p>

        <div className="pf-sect">
          <div className="pf-sect__head">
            <h2 className="pf-sect__title">Robot checks</h2>
            <span className="pf-sect__count">
              {passed} of {checks.length} ready
            </span>
            <button
              type="button"
              className="btn quiet sm"
              onClick={() => run(onRefresh)}
              title="Check again — this also happens automatically every few seconds."
            >
              Check again
            </button>
          </div>

          {unreachable && (
            <div className="pf-alert" role="status">
              <strong>Can&apos;t reach the robot</strong>
              <span>{readiness.error || 'Is stretch_body_server running?'}</span>
            </div>
          )}

          <ul className="pf-checks">
            {checks.map((c) => (
              <CheckRow key={c.id} {...rowFor(c)} />
            ))}
          </ul>

          {readiness?.action_error && (
            <p className="pf-alert" role="status">
              Last robot action failed: {readiness.action_error}
            </p>
          )}
        </div>

        <div className="pf-sect">
          <h2 className="pf-sect__title">Setup</h2>
          {children}
        </div>

        <div className="pf-foot">
          <button
            type="button"
            className="btn primary block"
            disabled={!allOk || !!blocker || starting}
            onClick={() => onStart({ skipReadiness: false })}
          >
            {starting ? (
              <>
                <span className="spinner" /> Starting…
              </>
            ) : (
              copy.start
            )}
          </button>

          {!starting && (!allOk || blocker) && <p className="pf-reason">{reason}</p>}

          {/* No skip while a home/stow the user started is still running — it
              will finish in a moment, and starting Nav2 mid-motion is worse
              than waiting. */}
          {!allOk && !starting && !busy && !skipOpen && (
            <button
              type="button"
              className="pf-skip"
              disabled={!!blocker}
              aria-expanded={false}
              aria-controls="pf-skipbox"
              onClick={() => setSkipOpen(true)}
            >
              Start anyway without the checks
            </button>
          )}

          {skipOpen && !starting && (
            <div className="pf-skipbox" id="pf-skipbox" role="group" aria-labelledby="pf-skip-title">
              <p className="pf-skipbox__title" id="pf-skip-title">
                Start without the robot checks?
              </p>
              <p className="pf-skipbox__lead">
                {risks.length ? `${copy.label} will start, but:` : `${copy.label} will start without checking the robot first.`}
              </p>
              {risks.length > 0 && (
                <ul className="pf-skipbox__list">
                  {risks.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
              <p className="pf-skipbox__foot">
                You can home and stow at any time from Actions in the top bar.
              </p>
              <div className="pf-skipbox__actions">
                <button type="button" className="btn quiet" autoFocus onClick={() => setSkipOpen(false)}>
                  Go back
                </button>
                <button
                  type="button"
                  className="btn warn"
                  onClick={() => {
                    setSkipOpen(false);
                    onStart({ skipReadiness: true });
                  }}
                >
                  Start without checks
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
