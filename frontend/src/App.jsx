import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, defaultRosbridgeUrl } from './api';
import MappingPage from './pages/MappingPage';
import EditMapPage from './pages/EditMapPage';
import NavigationPage from './pages/NavigationPage';
import ActionsMenu from './components/ActionsMenu';
import ErrorBoundary from './components/ErrorBoundary';
import RobotStatusPanel from './components/RobotStatusPanel';
import RunstopBanner from './components/RunstopBanner';
import RunstopButton from './components/RunstopButton';
import { useRobotReadiness } from './hooks/useRobotReadiness';
import { useRunstop } from './hooks/useRunstop';
import rosConnectionManager from './ros/rosConnectionManager';

const MODES = [
  {
    id: 'mapping',
    label: 'Mapping',
    step: 'Step 1',
    description: 'Drive the robot around with the gamepad to build a map, then save it.',
  },
  {
    id: 'edit_map',
    label: 'Edit Map',
    step: 'Step 2 · optional',
    description: 'Erase stray walls and paint keepout / speed zones on a saved map.',
  },
  {
    id: 'navigation',
    label: 'Navigation',
    step: 'Step 3',
    description: 'Tell the robot where it is, then send it places on the map.',
  },
];

function JoystickIcon({ connected }) {
  const color = connected ? 'var(--ok)' : 'var(--danger)';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: 'middle' }}
      aria-hidden="true"
    >
      <line x1="12" y1="4" x2="12" y2="12" />
      <circle cx="12" cy="3" r="1.6" fill={color} />
      <rect x="4" y="12" width="16" height="8" rx="2" />
    </svg>
  );
}

export default function App() {
  const [page, setPage] = useState('home');
  const [status, setStatus] = useState(null);
  const [rosOk, setRosOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rosbridgeUrl, setRosbridgeUrl] = useState(defaultRosbridgeUrl(9090));
  const [actionsOpen, setActionsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const active = status?.active_mode;

  // One readiness poller for the whole app, always running.
  const { readiness, refresh, home, stow } = useRobotReadiness();
  const runstop = useRunstop({ readiness, refresh, onError: setError });

  const robot = useMemo(
    () => ({ readiness, refresh, home, stow, runstop }),
    [readiness, refresh, home, stow, runstop]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api('/api/status');
      setStatus(s);
      if (s.rosbridge_port) {
        setRosbridgeUrl(defaultRosbridgeUrl(s.rosbridge_port));
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 4000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await rosConnectionManager.getConnection(rosbridgeUrl);
        if (!cancelled) setRosOk(true);
      } catch {
        if (!cancelled) setRosOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rosbridgeUrl]);

  const enterMode = async (modeId) => {
    setError('');
    setBusy(true);
    try {
      if (modeId === 'mapping') {
        setPage('mapping');
      } else if (modeId === 'edit_map') {
        await api('/api/modes/edit_map/start', { method: 'POST', body: '{}' });
        setPage('edit_map');
      } else if (modeId === 'navigation') {
        // Stop any robot mode; user picks a map then presses Start navigation.
        await api('/api/modes/stop', { method: 'POST', body: '{}' });
        setPage('navigation');
      }
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const stopMode = async () => {
    setBusy(true);
    try {
      await api('/api/modes/stop', { method: 'POST', body: '{}' });
      setPage('home');
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Stretch4 Nav Webapp</div>
        <nav className="mode-nav">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mode-btn ${page === m.id ? 'active' : ''} ${active === m.id ? 'running' : ''}`}
              disabled={busy}
              onClick={() => enterMode(m.id)}
            >
              {m.label}
            </button>
          ))}
          <button type="button" className="mode-btn" disabled={busy} onClick={() => setPage('home')}>
            Overview
          </button>
          <button type="button" className="mode-btn" disabled={busy || !active} onClick={stopMode}>
            Stop mode
          </button>
        </nav>
        <RunstopButton
          engaged={runstop.engaged}
          pending={runstop.pending}
          onEngage={runstop.engage}
          onRelease={runstop.release}
        />
        <RobotStatusPanel
          readiness={readiness}
          runstop={runstop}
          onRefresh={refresh}
          open={statusOpen}
          onOpenChange={setStatusOpen}
        />
        <ActionsMenu
          readiness={readiness}
          onHome={home}
          onStow={stow}
          onRefresh={refresh}
          onError={setError}
          activeMode={active || null}
          open={actionsOpen}
          onOpenChange={setActionsOpen}
        />
        <div className="status-pill">
          <span><span className={`dot ${rosOk ? 'on' : 'off'}`} /> rosbridge</span>
          <span
            className="dongle-status"
            title={status?.dongle_connected ? 'Gamepad dongle connected' : 'Gamepad dongle not detected'}
          >
            <JoystickIcon connected={!!status?.dongle_connected} /> gamepad
          </span>
          <span>mode: {active || 'idle'}</span>
          {busy && <span>…</span>}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" className="btn" style={{ marginLeft: 12 }} onClick={() => setError('')}>
            dismiss
          </button>
        </div>
      )}

      <main className="main">
        {(page === 'mapping' || page === 'navigation') && active === page && (
          <RunstopBanner runstop={runstop} />
        )}
        <ErrorBoundary key={page} onError={setError}>
          {page === 'home' && (
            <div className="home-hero">
              <h1>Stretch4 Nav Webapp</h1>
              <p style={{ color: 'var(--text-muted)', maxWidth: 480, textAlign: 'center' }}>
                First time? Build a map of the space, optionally mark zones on it,
                then navigate. Already have a map? Jump straight to Navigation.
              </p>
              <div className="home-cards">
                {MODES.map((m) => (
                  <button key={m.id} type="button" className="home-card" disabled={busy} onClick={() => enterMode(m.id)}>
                    <span className="home-card__step">{m.step}</span>
                    <h3>{m.label}</h3>
                    <p>{m.description}</p>
                  </button>
                ))}
              </div>
              {status?.maps_dir && (
                <p className="hint" style={{ color: 'var(--text-muted)' }}>
                  Maps: {status.maps_dir}
                </p>
              )}
            </div>
          )}
          {page === 'mapping' && (
            <MappingPage
              rosbridgeUrl={rosbridgeUrl}
              mappingActive={status?.active_mode === 'mapping'}
              robot={robot}
              onStatusRefresh={refreshStatus}
              onError={setError}
              onBusy={setBusy}
            />
          )}
          {page === 'edit_map' && (
            <EditMapPage onError={setError} onBusy={setBusy} />
          )}
          {page === 'navigation' && (
            <NavigationPage
              rosbridgeUrl={rosbridgeUrl}
              navActive={status?.active_mode === 'navigation'}
              robot={robot}
              onStatusRefresh={refreshStatus}
              onError={setError}
              onBusy={setBusy}
            />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
